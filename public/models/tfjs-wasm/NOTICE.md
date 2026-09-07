# TensorFlow.js WASM runtime

Unmodified WASM binaries copied from `@tensorflow/tfjs-backend-wasm@4.22.0/dist/`.

Copyright 2019-2020 Google LLC. All Rights Reserved. Licensed under Apache 2.0; see `LICENSE`.

Official source and deployment instructions: https://github.com/tensorflow/tfjs/tree/master/tfjs-backend-wasm

The application sets an explicit same-origin WASM path and one CPU thread. It does not download runtime files from a CDN. All three shipped capability variants are retained so the runtime can select the matching browser feature set.
