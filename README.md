# HyperDX Distribution of OpenTelemetry for React Native

> :construction: This project is currently **Experimental**. Do not use it in production environments.

## Overview

This library lets you autoinstrument React Native applications. Minimum supported React Native version is 0.68.
To instrument applications running on React Native versions lower than 0.68, see [Instrument lower versions](#instrument-lower-versions).

## Get started

To instrument your React Native application, follow these steps.

1. Install the library using either npm or yarn:

```
# npm
npm install @hyperdx/otel-react-native

# yarn
yarn add @hyperdx/otel-react-native
```

2. Initialize the library as early in your app lifecycle as possible:

```js
import { HyperDXRum } from '@hyperdx/otel-react-native';

const Rum = HyperDXRum.init({
  service: 'reactNativeTest',
  apiKey: 'token',
});

```

3. Customize the initialization parameters to specify:

- `apiKey`: Your HyperDX API key. You can find it [here](https://www.hyperdx.io/team).
- `service`: Name of your application. Set it to distinguish your app from others in HyperDX.

> If needed, you can set a different target URL by specifying a value for `beaconEndpoint`.

### Instrument lower versions

To instrument applications running on React Native versions lower than 0.68, edit your `metro.config.js` file to force metro to use browser specific packages. For example:

```js
const defaultResolver = require('metro-resolver');

module.exports = {
  resolver: {
    resolveRequest: (context, realModuleName, platform, moduleName) => {
      const resolved = defaultResolver.resolve(
        {
          ...context,
          resolveRequest: null,
        },
        moduleName,
        platform,
      );

      if (
        resolved.type === 'sourceFile' &&
        resolved.filePath.includes('@opentelemetry')
      ) {
        resolved.filePath = resolved.filePath.replace(
          'platform\\node',
          'platform\\browser',
        );
        return resolved;
      }

      return resolved;
    },
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
};
```

## View navigation

[react-navigation](https://github.com/react-navigation/react-navigation) version 5 and 6 are supported.

The following example shows how to instrument navigation:

```js
import { startNavigationTracking } from '@hyperdx/otel-react-native';

export default function App() {
  const navigationRef = useNavigationContainerRef();
  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        startNavigationTracking(navigationRef);
      }}
    >
      <Stack.Navigator>
        ...
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

## Data collection

The library exports data using the Zipkin exporter. Adding your own exporters and processors isn't supported yet.

Supported features:

- Autoinstrumented HTTP requests
- Autoinstrumented JS Error tracking
- Autoinstrumented navigation tracking for react-navigation
- Session tracking
- Custom instrumentation using Opentelemetry
- Capturing native crashes

For more information about how this library uses Opentelemetry and about future plans check [CONTRIBUTING.md](CONTRIBUTING.md#Opentelemetry).
