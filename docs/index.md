# Shade

Shade is a general purpose image editing library, including a professional editor interface for web, desktop and mobile.

Its built from some grounded building blocks, that can be used indivudually to build custom image editing experiences.

The shade-lib includes the core editing operations responsible for correct in-colorspace operations. Combined with shade-io, responsible for loading, encoding and decoding images + database storage, it provides a integrateable editing experience for web, desktop and mobile.

The base library then is used with, for example, shade-cli, shade-web or shade-tauri, to actually build interfaces for it.
