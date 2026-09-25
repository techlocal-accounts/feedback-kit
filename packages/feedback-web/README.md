# Feedback web capture

`captureFeedbackViewport` lazy-loads `html2canvas-pro`, masks private content in the detached clone, resizes and compresses the image, and returns a JPEG `Blob` plus metadata. `compressFeedbackImageFile` accepts PNG, JPEG, WebP, or GIF up to 12 MB; GIF is converted from its default/first frame to a static JPEG. It never uploads or stores the image. The app uploads to tenant-isolated private storage and passes only its opaque `privateRef` in the v1 submission.

Call `captureBeforeComposerOpen(() => captureFeedbackViewport(options), image => openComposer(image))` from the trigger. The app's composer supplies preview, annotation, remove, and retry controls. Add `data-feedback-capture-exclude` to the trigger/composer so they do not appear in the capture. Mark all sensitive elements `data-feedback-private` or add app selectors. For clinical routes, set `clinical.isClinicalScreen` and require selectors for every clinical content wrapper. Required clinical selectors are automatically masked; a missing mask throws before rasterization and leaves the composer unopened.

The default clone mask hides form controls, editable content, data-marked private/PII/PHI regions, iframe, video, and canvas content. Audit each app's dynamic content and selectors; the generic mask cannot infer every private text node.
