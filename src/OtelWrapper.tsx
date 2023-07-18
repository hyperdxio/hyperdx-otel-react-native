/*
Copyright 2023 Splunk Inc.

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

import React, { useEffect } from 'react';
import type { PropsWithChildren } from 'react';
import type { ReactNativeConfiguration } from './splunkRum';
import { HyperDXRum } from './splunkRum';

type Props = PropsWithChildren<{
  configuration: ReactNativeConfiguration;
}>;

let isInitialized = false;

export const OtelWrapper: React.FC<Props> = ({ children, configuration }) => {
  useEffect(() => {
    HyperDXRum.finishAppStart();
  }, []);

  if (!isInitialized) {
    HyperDXRum.init(configuration);
    isInitialized = true;
  } else {
    console.log('Already initialized');
  }

  return <>{children}</>;
};
