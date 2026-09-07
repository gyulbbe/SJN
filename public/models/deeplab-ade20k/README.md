# Bundled local room segmentation model

Model: Google / TensorFlow DeepLabV3 MobileNetV2 trained on ADE20K, TFJS quantized uint8 (one byte), source version 1.

- Official model: https://www.kaggle.com/models/tensorflow/deeplab/TfJs/ade20k-1-quantized/1
- Downloaded 2026-09-06 from the official URL used by TensorFlow's DeepLab package:
  `https://tfhub.dev/tensorflow/tfjs-model/deeplab/ade20k/1/quantized/1/1/model.json?tfjs-format=file`
- Weight shard: same directory, `group1-shard1of1?tfjs-format=file`.
- Official implementation and label definitions: https://github.com/tensorflow/tfjs-models/tree/master/deeplab
- License: Apache 2.0. Full license is in `LICENSE`; `upstream-metadata.json` preserves the official Kaggle API's model variation license record. That record describes the latest version (2); the bundled files are explicitly pinned to version 1 above. The graph's 161 quantized tensors declare `uint8`.
- Copyright 2019 Google LLC. All Rights Reserved.

Bundled files are unchanged model artifacts:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| model.json | 143,776 | 32740c83ed674645762d0d664ee84c4854b96e80f16ba6a80202d3af176bf4e1 |
| group1-shard1of1 | 2,294,595 | 82f62665e01cf0d94e5df172d4bd1efb6ddcddbaa9bb40fac73b9e55d1e7e192 |

The application reads this graph and shard from its own origin, then executes CPU WASM inside a Web Worker. Photos and product images are never sent to a model service. The graph accepts RGB integer pixels and includes normalization and semantic prediction. ADE20K labels include background at 0, wall at 1, and floor at 4. The result is mapped back to the full oriented photograph's aspect ratio with a longest side of at most 512 pixels.

This is a semantic estimate, not survey-grade geometry or a guaranteed object cutout. Doors, trim, reflections, taps and other small objects can be mislabeled. Manual surface and protection edits remain necessary for some photographs. `tests/segmentation-browser.ts` runs the actual bundled graph, records local-only requests, checks landscape/portrait dimensions and saves a visible overlay.
