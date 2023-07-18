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

HyperDXRum.init({
  service: 'my-rn-app',
  apiKey: '<YOUR_API_KEY_HERE>',
  tracePropagationTargets: [/api.myapp.domain/i], // Set to link traces from frontend to backend requests
});
```

3. Customize the initialization parameters to specify:

- `apiKey`: Your HyperDX Ingestion API key. You can find it [here](https://www.hyperdx.io/team).
- `service`: Name of your application. Set it to distinguish your app from others in HyperDX.
- `tracePropagationTargets`: A list of regular expressions that match the URLs of your backend services. Set it to link traces from frontend to backend requests.

### (Optional) Attach User Information or Metadata

Attaching user information will allow you to search/filter sessions and events in HyperDX. This can be called at any point during the client session. The current client session and all events sent after the call will be associated with the user information.

`userEmail`, `userName`, and `teamName` will populate the sessions UI with the corresponding values, but can be omitted. Any other additional values can be specified and used to search for events.

```js
HyperDXRum.setGlobalAttributes({
  userEmail: user.email,
  userName: user.name,
  teamName: user.team.name,
  // Other custom properties...
});
```

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

## License

https://github.com/signalfx/splunk-otel-react-native#license
