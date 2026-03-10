use wasm_bindgen::prelude::*;

mod engine;
mod bridge;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    console_log("Shade WASM engine initialised");
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);
}

// Re-export public API
pub use bridge::*;
