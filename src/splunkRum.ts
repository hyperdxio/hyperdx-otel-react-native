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
  trace,
  context,
  Span,
  Attributes,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
} from '@opentelemetry/api';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { _globalThis } from '@opentelemetry/core';

import {
  initializeNativeSdk,
  NativeSdKConfiguration,
  setNativeSessionId,
  testNativeCrash,
  AppStartInfo,
} from './native';
import ReacNativeSpanExporter from './exporting';
import GlobalAttributeAppender from './globalAttributeAppender';
import { instrumentXHR } from './instrumentations/xhr';
import { instrumentErrors, reportError } from './instrumentations/errors';
import { getResource, setGlobalAttributes } from './globalAttributes';
import { LOCATION_LATITUDE, LOCATION_LONGITUDE } from './splunkAttributeNames';
import { getSessionId, _generatenewSessionId } from './session';
import { Platform } from 'react-native';

export interface ReactNativeConfiguration {
  beaconEndpoint?: string;
  apiKey: string;
  networkHeadersCapture?: boolean;
  service: string;
  deploymentEnvironment?: string;
  allowInsecureBeacon?: boolean;
  appStartEnabled?: boolean;
  enableDiskBuffering?: boolean;
  limitDiskUsageMegabytes?: number;
  truncationCheckpoint?: number;
  bufferTimeout?: number;
  bufferSize?: number;
  debug?: boolean;
  /** Sets attributes added to every Span. */
  globalAttributes?: Attributes;
  /**
   * URLs that partially match any regex in ignoreUrls will not be traced.
   * In addition, URLs that are _exact matches_ of strings in ignoreUrls will
   * also not be traced.
   */
  ignoreUrls?: Array<string | RegExp>;

  tracePropagationTargets?: (string | RegExp)[];
}

export interface HyperDXRumType {
  appStartSpan?: Span | undefined;
  appStartEnd: number | null;
  finishAppStart: () => void;
  init: (options: ReactNativeConfiguration) => HyperDXRumType | undefined;
  provider?: WebTracerProvider;
  _generatenewSessionId: () => void;
  _testNativeCrash: () => void;
  reportError: (err: any, isFatal?: boolean) => void;
  setGlobalAttributes: (attributes: Attributes) => void;
  updateLocation: (latitude: number, longitude: number) => void;
}

const DEFAULT_CONFIG = {
  appStartEnabled: true,
  enableDiskBuffering: true,
};

let appStartInfo: AppStartInfo | null = null;
let isInitialized = false;

export const HyperDXRum: HyperDXRumType = {
  appStartEnd: null,
  finishAppStart() {
    if (this.appStartSpan && this.appStartSpan.isRecording()) {
      this.appStartSpan.end();
    } else {
      this.appStartEnd = Date.now();
      diag.debug('AppStart: end called without start');
    }
  },
  init(configugration: ReactNativeConfiguration) {
    const config = {
      ...DEFAULT_CONFIG,
      ...configugration,
    };

    diag.setLogger(
      new DiagConsoleLogger(),
      config?.debug ? DiagLogLevel.DEBUG : DiagLogLevel.ERROR
    );

    if (isInitialized) {
      diag.warn('SplunkRum already init()ed.');
      return;
    }
    //by default wants to use otlp
    if (!('OTEL_TRACES_EXPORTER' in _globalThis)) {
      (_globalThis as any).OTEL_TRACES_EXPORTER = 'none';
    }

    const clientInit = Date.now();
    if (!config.service) {
      diag.error('service name is required.');
      return;
    }

    if (!config.apiKey) {
      diag.error('When sending data to HyperDX apiKey is required.');
      return;
    }

    const nativeSdkConf: NativeSdKConfiguration = {};

    // TODO: eventually we want to migrate to native OTLP exporter
    nativeSdkConf.beaconEndpoint =
      'https://in-otel.hyperdx.io:9411/api/v2/spans';
    nativeSdkConf.enableDiskBuffering = config.enableDiskBuffering;
    nativeSdkConf.limitDiskUsageMegabytes = config.limitDiskUsageMegabytes;
    nativeSdkConf.apiKey = config.apiKey;
    nativeSdkConf.globalAttributes = { ...getResource() };

    if (config.beaconEndpoint) {
      if (
        !config.beaconEndpoint.startsWith('https') &&
        !config.allowInsecureBeacon
      ) {
        diag.error(
          'Not using https is unsafe, if you want to force it use allowInsecureBeacon option.'
        );
        return;
      }
      nativeSdkConf.beaconEndpoint = config.beaconEndpoint;
    }

    addGlobalAttributesFromConf(config);
    const provider = new WebTracerProvider({});
    provider.addSpanProcessor(new GlobalAttributeAppender());
    provider.addSpanProcessor(
      new BatchSpanProcessor(new ReacNativeSpanExporter(), {
        scheduledDelayMillis: config.bufferTimeout || 3000,
        maxExportBatchSize: config.bufferSize || 20,
      })
    );
    provider.register({});
    this.provider = provider;
    const clientInitEnd = Date.now();

    instrumentXHR({
      ignoreUrls: config.ignoreUrls,
      propagateTraceHeaderCorsUrls: config.tracePropagationTargets,
      networkHeadersCapture: config.networkHeadersCapture,
    });
    instrumentErrors();

    const nativeInit = Date.now();

    diag.debug(
      'Initializing with: ',
      config.service,
      nativeSdkConf.beaconEndpoint,
      nativeSdkConf.apiKey?.substring(0, 5),
      nativeSdkConf.enableDiskBuffering
    );

    //TODO do not send appStartInfo in init response
    initializeNativeSdk(nativeSdkConf).then((nativeAppStart) => {
      appStartInfo = nativeAppStart;
      if (Platform.OS === 'ios') {
        appStartInfo.isColdStart = appStartInfo.isColdStart || true;
        appStartInfo.appStart =
          appStartInfo.appStart || appStartInfo.moduleStart;
      }
      setNativeSessionId(getSessionId());

      if (config.appStartEnabled) {
        const tracer = provider.getTracer('AppStart');
        const nativeInitEnd = Date.now();

        this.appStartSpan = tracer.startSpan('AppStart', {
          startTime: appStartInfo.appStart,
          attributes: {
            'component': 'appstart',
            'start.type': appStartInfo.isColdStart ? 'cold' : 'warm',
          },
        });

        //FIXME no need to have native init span probably
        const ctx = trace.setSpan(context.active(), this.appStartSpan);

        context.with(ctx, () => {
          tracer
            .startSpan('SplunkRum.nativeInit', { startTime: nativeInit })
            .end(nativeInitEnd);
          tracer
            .startSpan('SplunkRum.jsInit', { startTime: clientInit })
            .end(clientInitEnd);
        });

        if (this.appStartEnd !== null) {
          diag.debug('AppStart: using manual end');
          this.appStartSpan.end(this.appStartEnd);
        }
      }
    });
    isInitialized = true;
    return this;
  },
  _generatenewSessionId: _generatenewSessionId,
  _testNativeCrash: testNativeCrash,
  reportError: reportError,
  setGlobalAttributes: setGlobalAttributes,
  updateLocation: updateLocation,
};

function addGlobalAttributesFromConf(config: ReactNativeConfiguration) {
  const confAttributes: Attributes = {
    ...config.globalAttributes,
  };
  confAttributes.app = config.service;

  // Attach __HDX_API_KEY
  if (config.apiKey) {
    confAttributes.__HDX_API_KEY = config.apiKey;
  }

  if (config.service) {
    confAttributes['process.serviceName'] = config.service;
  }

  if (config.deploymentEnvironment) {
    confAttributes['deployment.environment'] = config.deploymentEnvironment;
  }

  setGlobalAttributes(confAttributes);
}

function updateLocation(latitude: number, longitude: number) {
  setGlobalAttributes({
    [LOCATION_LATITUDE]: latitude,
    [LOCATION_LONGITUDE]: longitude,
  });
}
