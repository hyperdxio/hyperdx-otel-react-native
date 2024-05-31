/*
Copyright 2022 Splunk Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
  PerformanceObserver,
  PerformanceResourceTiming,
} from 'react-native-performance';

import * as api from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import {
  PerformanceTimingNames as PTN,
  addSpanNetworkEvents,
  getResource,
} from '@opentelemetry/sdk-trace-web';
import {
  hrTime,
  isUrlIgnored,
  otperformance,
  urlMatches,
} from '@opentelemetry/core';
import UserAgent from 'react-native-user-agent';
import { wrap } from 'shimmer';
import { URL } from 'react-native-url-polyfill';

import { captureTraceParent } from '../serverTiming';

import type {
  OpenFunction,
  SendFunction,
  XhrMem,
} from '@opentelemetry/instrumentation-xml-http-request/build/src/types';
import type { PropagateTraceHeaderCorsUrls } from '@opentelemetry/sdk-trace-web/build/src/types';

const parseUrl = (url: string) => new URL(url);

const MAX_BODY_LENGTH = 5 * 1024; // 5KB

interface XhrConfig {
  clearTimingResources?: boolean;
  ignoreUrls: Array<string | RegExp> | undefined;
  propagateTraceHeaderCorsUrls?: (string | RegExp)[];
  networkHeadersCapture?: boolean;
  networkBodyCapture?: boolean;
}

class TaskCounter {
  private _tasksCount = 0;

  get tasksCount() {
    return this._tasksCount;
  }

  increment() {
    this._tasksCount++;
  }

  decrement() {
    this._tasksCount--;
  }
}

/**
 * https://github.com/open-telemetry/opentelemetry-specification/blob/master/specification/trace/semantic_conventions/http.md
 */
export enum AttributeNames {
  COMPONENT = 'component',
  HTTP_ERROR_NAME = 'http.error_name',
  HTTP_STATUS_TEXT = 'http.status_text',
}

export enum EventNames {
  EVENT_ABORT = 'abort',
  EVENT_ERROR = 'error',
  EVENT_LOAD = 'loaded',
  EVENT_READY_STATE_CHANGE = 'readystatechange',
  EVENT_TIMEOUT = 'timeout',
  METHOD_OPEN = 'open',
  METHOD_SEND = 'send',
}

// how long to wait for observer to collect information about resources
// this is needed as event "load" is called before observer
// hard to say how long it should really wait, seems like 300ms is
// safe enough
const OBSERVER_WAIT_TIME_MS = 300;

/**
 * Checks if trace headers should be propagated
 * @param spanUrl
 * @private
 */
export function shouldPropagateTraceHeaders(
  spanUrl: string,
  propagateTraceHeaderCorsUrls?: PropagateTraceHeaderCorsUrls
): boolean {
  let propagateTraceHeaderUrls = propagateTraceHeaderCorsUrls || [];
  if (
    typeof propagateTraceHeaderUrls === 'string' ||
    propagateTraceHeaderUrls instanceof RegExp
  ) {
    propagateTraceHeaderUrls = [propagateTraceHeaderUrls];
  }
  return propagateTraceHeaderUrls.some((propagateTraceHeaderUrl) =>
    urlMatches(spanUrl, propagateTraceHeaderUrl)
  );
}

// From: https://github.com/open-telemetry/opentelemetry-js/blob/87f21ef8aecaa1e52ff9200a99497276ffa2956b/experimental/packages/opentelemetry-instrumentation-xml-http-request/src/xhr.ts#L344
export class XMLHttpRequestInstrumentation {
  private _config: XhrConfig;

  private _diag = api.diag;

  private tracer = api.trace.getTracer('xhr');

  private _xhrMem = new WeakMap<XMLHttpRequest, XhrMem>();

  private _usedResources = new WeakSet<PerformanceResourceTiming>();

  private _tasksCount = 0;

  constructor(config: XhrConfig) {
    this._config = config;
  }

  private _getConfig(): XhrConfig {
    return this._config;
  }

  /**
   * Removes the previous information about span.
   * This might happened when the same xhr is used again.
   * @param xhr
   * @private
   */
  private _cleanPreviousSpanInformation(xhr: XMLHttpRequest) {
    const xhrMem = this._xhrMem.get(xhr);
    if (xhrMem) {
      const callbackToRemoveEvents = xhrMem.callbackToRemoveEvents;
      if (callbackToRemoveEvents) {
        callbackToRemoveEvents();
      }
      this._xhrMem.delete(xhr);
    }
  }

  private _createSpan(
    xhr: XMLHttpRequest,
    url: string,
    method: string
  ): api.Span | undefined {
    if (isUrlIgnored(url, this._getConfig().ignoreUrls)) {
      this._diag.debug('ignoring span as url matches ignored url');
      return;
    }
    const spanName = method.toUpperCase();

    const currentSpan = this.tracer.startSpan(spanName, {
      kind: api.SpanKind.CLIENT,
      attributes: {
        [SemanticAttributes.HTTP_METHOD]: method,
        [SemanticAttributes.HTTP_URL]: parseUrl(url).toString(),
        [AttributeNames.COMPONENT]: 'http',
      },
    });

    currentSpan.addEvent(EventNames.METHOD_OPEN);

    this._cleanPreviousSpanInformation(xhr);

    this._xhrMem.set(xhr, {
      span: currentSpan,
      spanUrl: url,
    });

    return currentSpan;
  }

  /**
   * Marks certain [resource]{@link PerformanceResourceTiming} when information
   * from this is used to add events to span.
   * This is done to avoid reusing the same resource again for next span
   * @param resource
   * @private
   */
  private _markResourceAsUsed(resource: PerformanceResourceTiming) {
    this._usedResources.add(resource);
  }

  /**
   * Finds appropriate resource and add network events to the span
   * @param span
   */
  private _findResourceAndAddNetworkEvents(
    xhrMem: XhrMem,
    span: api.Span,
    spanUrl?: string,
    startTime?: api.HrTime,
    endTime?: api.HrTime
  ): void {
    if (!spanUrl || !startTime || !endTime || !xhrMem.createdResources) {
      return;
    }

    let resources: PerformanceResourceTiming[] =
      xhrMem.createdResources.entries;

    if (!resources || !resources.length) {
      // fallback - either Observer is not available or it took longer
      // then OBSERVER_WAIT_TIME_MS and observer didn't collect enough
      // information
      // ts thinks this is the perf_hooks module, but it is the browser performance api
      resources = (otperformance as any).getEntriesByType(
        'resource'
      ) as PerformanceResourceTiming[];
    }

    const resource = getResource(
      parseUrl(spanUrl).href,
      startTime,
      endTime,
      resources,
      this._usedResources
    );

    if (resource.mainRequest) {
      const mainRequest = resource.mainRequest;
      this._markResourceAsUsed(mainRequest);

      const corsPreFlightRequest = resource.corsPreFlightRequest;
      if (corsPreFlightRequest) {
        this._addChildSpan(span, corsPreFlightRequest);
        this._markResourceAsUsed(corsPreFlightRequest);
      }
      addSpanNetworkEvents(span, mainRequest);
    }
  }

  /**
   * Clears the resource timings and all resources assigned with spans
   *     when {@link XMLHttpRequestInstrumentationConfig.clearTimingResources} is
   *     set to true (default false)
   * @private
   */
  private _clearResources() {
    if (this._tasksCount === 0 && this._getConfig().clearTimingResources) {
      (otperformance as any).clearResourceTimings();
      this._xhrMem = new WeakMap<XMLHttpRequest, XhrMem>();
      this._usedResources = new WeakSet<PerformanceResourceTiming>();
    }
  }

  /**
   * Adds custom headers to XMLHttpRequest
   * @param xhr
   * @param spanUrl
   * @private
   */
  private _addHeaders(xhr: XMLHttpRequest, spanUrl: string) {
    const url = parseUrl(spanUrl).href;
    if (
      !shouldPropagateTraceHeaders(
        url,
        this._getConfig().propagateTraceHeaderCorsUrls
      )
    ) {
      const headers: Partial<Record<string, unknown>> = {};
      api.propagation.inject(api.context.active(), headers);
      if (Object.keys(headers).length > 0) {
        this._diag.debug('headers inject skipped due to CORS policy');
      }
      return;
    }
    const headers: { [key: string]: unknown } = {};
    api.propagation.inject(api.context.active(), headers);
    Object.keys(headers).forEach((key: any) => {
      xhr.setRequestHeader(key, String(headers[key]));
    });
  }

  /**
   * Add cors pre flight child span
   * @param span
   * @param corsPreFlightRequest
   * @private
   */
  private _addChildSpan(
    span: api.Span,
    corsPreFlightRequest: PerformanceResourceTiming
  ): void {
    api.context.with(api.trace.setSpan(api.context.active(), span), () => {
      const childSpan = this.tracer.startSpan('CORS Preflight', {
        startTime: corsPreFlightRequest[PTN.FETCH_START],
      });
      addSpanNetworkEvents(childSpan, corsPreFlightRequest);
      childSpan.end(corsPreFlightRequest[PTN.RESPONSE_END]);
    });
  }

  /**
   * will collect information about all resources created
   * between "send" and "end" with additional waiting for main resource
   * @param xhr
   * @param spanUrl
   * @private
   */
  private _addResourceObserver(xhr: XMLHttpRequest, spanUrl: string) {
    const xhrMem = this._xhrMem.get(xhr);
    if (!xhrMem || typeof PerformanceObserver !== 'function') {
      return;
    }
    xhrMem.createdResources = {
      observer: new PerformanceObserver((list) => {
        const entries = list.getEntries() as PerformanceResourceTiming[];
        const parsedUrl = parseUrl(spanUrl);

        entries.forEach((entry) => {
          if (
            entry.initiatorType === 'xmlhttprequest' &&
            entry.name === parsedUrl.href
          ) {
            if (xhrMem.createdResources) {
              xhrMem.createdResources.entries.push(entry);
            }
          }
        });
      }),
      entries: [],
    };

    xhrMem.createdResources.observer.observe({
      entryTypes: ['resource'],
    });
  }

  protected _wrap = (moduleExports: any, name: string, wrapper: any) => {
    const wrapped = wrap(Object.assign({}, moduleExports), name, wrapper);

    return Object.defineProperty(moduleExports, name, {
      value: wrapped,
    });
  };

  /**
   * Patches the method open
   * @private
   */
  protected _patchOpen() {
    const plugin = this;
    return (original: OpenFunction): OpenFunction => {
      return function patchOpen(this: XMLHttpRequest, ...args): void {
        const method: string = args[0];
        const url: string = args[1];
        plugin._createSpan(this, url, method);

        return original.apply(this, args);
      };
    };
  }

  /**
   * Patches the method send
   * @private
   */
  protected _patchSend() {
    const plugin = this;

    function endSpanTimeout(
      eventName: string,
      xhrMem: XhrMem,
      performanceEndTime: api.HrTime,
      endTime: number
    ) {
      const callbackToRemoveEvents = xhrMem.callbackToRemoveEvents;

      if (typeof callbackToRemoveEvents === 'function') {
        callbackToRemoveEvents();
      }

      const { span, spanUrl, sendStartTime } = xhrMem;

      if (span) {
        plugin._findResourceAndAddNetworkEvents(
          xhrMem,
          span,
          spanUrl,
          sendStartTime,
          performanceEndTime
        );
        span.addEvent(eventName, endTime);
        plugin._addFinalSpanAttributes(span, xhrMem, spanUrl);
        span.end(endTime);
        plugin._tasksCount--;
      }
      plugin._clearResources();
    }

    function endSpan(eventName: string, xhr: XMLHttpRequest) {
      const xhrMem = plugin._xhrMem.get(xhr);
      if (!xhrMem) {
        return;
      }
      xhrMem.status = xhr.status;
      xhrMem.statusText = xhr.statusText;
      plugin._xhrMem.delete(xhr);

      // if (xhrMem.span) {
      //   plugin._applyAttributesAfterXHR(xhrMem.span, xhr);
      // }

      const performanceEndTime = hrTime();
      const endTime = Date.now();

      // the timeout is needed as observer doesn't have yet information
      // when event "load" is called. Also the time may differ depends on
      // browser and speed of computer
      setTimeout(() => {
        endSpanTimeout(eventName, xhrMem, performanceEndTime, endTime);
      }, OBSERVER_WAIT_TIME_MS);
    }

    function onError(this: XMLHttpRequest) {
      endSpan(EventNames.EVENT_ERROR, this);
    }

    function onAbort(this: XMLHttpRequest) {
      endSpan(EventNames.EVENT_ABORT, this);
    }

    function onTimeout(this: XMLHttpRequest) {
      endSpan(EventNames.EVENT_TIMEOUT, this);
    }

    function onLoad(this: XMLHttpRequest) {
      if (this.status < 299) {
        endSpan(EventNames.EVENT_LOAD, this);
      } else {
        endSpan(EventNames.EVENT_ERROR, this);
      }
    }

    function onReadyStateChange(this: XMLHttpRequest) {
      // const xhrMem = plugin._xhrMem.get(this);
      // if (!xhrMem) {
      //   return;
      // }
      // const { span } = xhrMem;
      // if (this.readyState === XMLHttpRequest.HEADERS_RECEIVED) {
      //   const headers = this.getAllResponseHeaders().toLowerCase();
      //   if (headers.indexOf('server-timing') !== -1) {
      //     const st = this.getResponseHeader('server-timing');
      //     if (st !== null) {
      //       captureTraceParent(st, span);
      //     }
      //   }
      // }
      if (this.readyState === XMLHttpRequest.DONE) {
        endSpan(EventNames.EVENT_READY_STATE_CHANGE, this);
        // span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, this.status);
        // span.end();
      }
    }

    function unregister(xhr: XMLHttpRequest) {
      xhr.removeEventListener('abort', onAbort);
      xhr.removeEventListener('error', onError);
      xhr.removeEventListener('load', onLoad);
      xhr.removeEventListener('timeout', onTimeout);
      xhr.removeEventListener('readystatechange', onReadyStateChange);
      const xhrMem = plugin._xhrMem.get(xhr);
      if (xhrMem) {
        xhrMem.callbackToRemoveEvents = undefined;
      }
    }

    return (original: SendFunction): SendFunction => {
      return function patchSend(this: XMLHttpRequest, ...args): void {
        const xhrMem = plugin._xhrMem.get(this);
        if (!xhrMem) {
          return original.apply(this, args);
        }
        const currentSpan = xhrMem.span;
        const spanUrl = xhrMem.spanUrl;

        if (currentSpan && spanUrl) {
          api.context.with(
            api.trace.setSpan(api.context.active(), currentSpan),
            () => {
              plugin._tasksCount++;
              xhrMem.sendStartTime = hrTime();
              currentSpan.addEvent(EventNames.METHOD_SEND);

              this.addEventListener('abort', onAbort);
              this.addEventListener('error', onError);
              this.addEventListener('load', onLoad);
              this.addEventListener('timeout', onTimeout);
              this.addEventListener('readystatechange', onReadyStateChange);

              xhrMem.callbackToRemoveEvents = () => {
                unregister(this);
                if (xhrMem.createdResources) {
                  xhrMem.createdResources.observer.disconnect();
                }
              };
              plugin._addHeaders(this, spanUrl);
              plugin._addResourceObserver(this, spanUrl);
            }
          );
        }
        return original.apply(this, args);
      };
    };
  }

  /**
   * Add attributes when span is going to end
   * @param span
   * @param xhr
   * @param spanUrl
   * @private
   */
  _addFinalSpanAttributes(span: api.Span, xhrMem: XhrMem, spanUrl?: string) {
    if (typeof spanUrl === 'string') {
      const parsedUrl = parseUrl(spanUrl);
      if (xhrMem.status !== undefined) {
        span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, xhrMem.status);
      }
      if (xhrMem.statusText !== undefined) {
        span.setAttribute(AttributeNames.HTTP_STATUS_TEXT, xhrMem.statusText);
      }
      span.setAttribute(SemanticAttributes.HTTP_HOST, parsedUrl.host);
      span.setAttribute(
        SemanticAttributes.HTTP_SCHEME,
        parsedUrl.protocol.replace(':', '')
      );

      // @TODO do we want to collect this or it will be collected earlier once only or
      //    maybe when parent span is not available ?
      span.setAttribute(
        SemanticAttributes.HTTP_USER_AGENT,
        UserAgent.getUserAgent()
      );
    }
  }

  enable() {
    this._wrap(XMLHttpRequest.prototype, 'open', this._patchOpen());
    this._wrap(XMLHttpRequest.prototype, 'send', this._patchSend());
  }
}

// NOT USED
export function instrumentXHROriginal(config: XhrConfig) {
  const instrumentor = new XMLHttpRequestInstrumentation(config);
  instrumentor.enable();
}

// TODO: make this into a class
export function instrumentXHR(config: XhrConfig) {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  const tracer = api.trace.getTracer('xhr');
  const taskCounter = new TaskCounter();

  let _xhrMem = new WeakMap<XMLHttpRequest, XhrMem>();

  function clearXhrMem(xhr: XMLHttpRequest) {
    const xhrMem = _xhrMem.get(xhr);
    if (xhrMem) {
      _xhrMem.delete(xhr);
    }
  }

  function createSpan(
    xhr: XMLHttpRequest,
    url: string,
    method: string
  ): api.Span | undefined {
    if (isUrlIgnored(url, config.ignoreUrls)) {
      api.diag.debug('ignoring span as url matches ignored url');
      return;
    }

    const spanName = method.toUpperCase();

    const currentSpan = tracer.startSpan(spanName, {
      kind: api.SpanKind.CLIENT,
      attributes: {
        [SemanticAttributes.HTTP_METHOD]: method,
        [SemanticAttributes.HTTP_URL]: parseUrl(url).toString(),
        [AttributeNames.COMPONENT]: 'http',
      },
    });

    currentSpan.addEvent(EventNames.METHOD_OPEN);

    clearXhrMem(xhr);

    _xhrMem.set(xhr, {
      span: currentSpan,
      spanUrl: url,
    });

    return currentSpan;
  }

  function addHeaders(xhr: XMLHttpRequest, spanUrl: string) {
    const url = parseUrl(spanUrl).href;
    if (
      !shouldPropagateTraceHeaders(url, config.propagateTraceHeaderCorsUrls)
    ) {
      const headers: Partial<Record<string, unknown>> = {};
      api.propagation.inject(api.context.active(), headers);
      if (Object.keys(headers).length > 0) {
        api.diag.debug('headers inject skipped due to CORS policy');
      }
      return;
    }
    const headers: { [key: string]: unknown } = {};
    api.propagation.inject(api.context.active(), headers);
    Object.keys(headers).forEach((key: any) => {
      xhr.setRequestHeader(key, String(headers[key]));
    });
  }

  function _addFinalSpanAttributes(
    span: api.Span,
    xhrMem: XhrMem,
    spanUrl?: string
  ) {
    if (typeof spanUrl === 'string') {
      const parsedUrl = parseUrl(spanUrl);
      if (xhrMem.status !== undefined) {
        span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, xhrMem.status);
      }
      if (xhrMem.statusText !== undefined) {
        span.setAttribute(AttributeNames.HTTP_STATUS_TEXT, xhrMem.statusText);
      }
      span.setAttribute(SemanticAttributes.HTTP_HOST, parsedUrl.host);
      span.setAttribute(
        SemanticAttributes.HTTP_SCHEME,
        parsedUrl.protocol.replace(':', '')
      );
    }
  }

  function _clearResources() {
    if (taskCounter.tasksCount === 0) {
      _xhrMem = new WeakMap<XMLHttpRequest, XhrMem>();
    }
  }

  function _normalizeHeader([key, value]: [string, string]): Record<
    string,
    api.AttributeValue
  > {
    const normalizedKey = key.toLowerCase().replace(/-/g, '_').trim();
    let normalizedValue: api.AttributeValue;

    // https://github.com/open-telemetry/opentelemetry-js/blob/82b7526b028a34a23936016768f37df05effcd59/experimental/packages/opentelemetry-instrumentation-http/src/utils.ts#L604C1-L611C1
    if (typeof value === 'string') {
      normalizedValue = [value];
    } else if (Array.isArray(value)) {
      normalizedValue = value;
    } else {
      normalizedValue = [value];
    }
    return { [normalizedKey]: normalizedValue };
  }

  function _normalizeHeaders(headersString: string): {
    [key: string]: api.AttributeValue;
  } {
    const lines = headersString.trim().split('\n');
    const normalizedHeaders: { [key: string]: api.AttributeValue } = {};

    lines.forEach((line) => {
      let [key, value] = line.trim().split(/:\s*/);
      if (key && value) {
        Object.assign(normalizedHeaders, _normalizeHeader([key, value]));
      }
    });

    return normalizedHeaders;
  }

  function _setHeaderAttributeForSpan(
    normalizedHeaders: { [key: string]: api.AttributeValue },
    type: 'request' | 'response',
    span: api.Span
  ) {
    Object.entries(normalizedHeaders).forEach(([key, value]) => {
      span.setAttribute(`http.${type}.header.${key}`, value);
    });
  }

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args) {
    const method = args[0];
    const url = args[1];
    createSpan(this, url, method);
    originalOpen.apply(this, args);
  };

  function endSpan(eventName: string, xhr: XMLHttpRequest) {
    const xhrMem = _xhrMem.get(xhr);
    if (!xhrMem) {
      return;
    }
    xhrMem.status = xhr.status;
    xhrMem.statusText = xhr.statusText;
    _xhrMem.delete(xhr);

    const endTime = Date.now();

    // inline endSpanTimeout
    const { span, spanUrl } = xhrMem;
    if (span) {
      // TODO: check if we need to call _findResourceAndAddNetworkEvents
      span.addEvent(eventName, endTime);
      _addFinalSpanAttributes(span, xhrMem, spanUrl);
      span.end(endTime);
      taskCounter.decrement();
    }
    _clearResources();
  }

  function _handleHeaderCapture(headers: string, currentSpan: api.Span) {
    if (config.networkHeadersCapture) {
      const normalizedHeaders = _normalizeHeaders(headers);
      _setHeaderAttributeForSpan(normalizedHeaders, 'response', currentSpan);
    }
  }

  if (config.networkHeadersCapture) {
    XMLHttpRequest.prototype.setRequestHeader = function (
      this: XMLHttpRequest,
      ...args
    ) {
      const [key, value] = args;
      const xhrMem = _xhrMem.get(this);
      if (xhrMem && key && value) {
        const normalizedHeader = _normalizeHeader([key, value]);
        // TODO: Store and dedupe the headers before adding them to the span
        _setHeaderAttributeForSpan(normalizedHeader, 'request', xhrMem.span);
      }
      originalSetRequestHeader.apply(this, args);
    };
  }

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args) {
    const requestBody = args[0];

    const xhrMem = _xhrMem.get(this);
    if (!xhrMem) {
      return originalSend.apply(this, args);
    }
    const currentSpan = xhrMem.span;
    const spanUrl = xhrMem.spanUrl;

    if (currentSpan && spanUrl) {
      api.context.with(
        api.trace.setSpan(api.context.active(), currentSpan),
        () => {
          taskCounter.increment();
          xhrMem.sendStartTime = hrTime();
          currentSpan.addEvent(EventNames.METHOD_SEND);
          if (config.networkBodyCapture) {
            let body: string = '';
            if (typeof requestBody === 'string') {
              body = requestBody;
            } else {
              try {
                body = JSON.stringify(requestBody);
              } catch (e) {
                body = '[object of type ' + typeof requestBody + ']';
              }
            }
            currentSpan.setAttribute(
              'http.request.body',
              body.slice(0, MAX_BODY_LENGTH)
            );
          }
          this.addEventListener('readystatechange', () => {
            if (this.readyState === XMLHttpRequest.HEADERS_RECEIVED) {
              const headers = this.getAllResponseHeaders().toLowerCase();
              _handleHeaderCapture(headers, currentSpan);
              if (headers.indexOf('server-timing') !== -1) {
                const st = this.getResponseHeader('server-timing');
                if (st !== null) {
                  captureTraceParent(st, currentSpan);
                }
              }
            } else if (this.readyState === XMLHttpRequest.DONE) {
              if (config.networkBodyCapture && this.responseType === 'blob') {
                new Response(this.response)
                  .text()
                  .then((text) => {
                    currentSpan.setAttribute('http.response.body', text);
                  })
                  .finally(() => {
                    endSpan(EventNames.EVENT_READY_STATE_CHANGE, this);
                  });
              } else {
                if (config.networkBodyCapture) {
                  currentSpan.setAttribute(
                    'http.response.body',
                    this.responseText
                  );
                }
                endSpan(EventNames.EVENT_READY_STATE_CHANGE, this);
              }
            }
          });
          addHeaders(this, spanUrl);
        }
      );
    }
    originalSend.apply(this, args);
  };
}
