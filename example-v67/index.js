/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {HyperDXRum} from '@hyperdx/otel-react-native';

export const Rum = HyperDXRum.init({
  beaconEndpoint: 'https://localhost:53820/zipkindump',
  service: 'reactNativeTest',
  apiKey: 'test',
  debug: true,
});

AppRegistry.registerComponent(appName, () => App);
