use anyhow::Result;
use ort::session::Session;

fn main() -> Result<()> {
    let model_dir = std::env::args().nth(1).expect("model dir required");

    for model in &["model", "vision_model", "text_model"] {
        let path = format!("{model_dir}/onnx/{model}.onnx");
        let session = Session::builder()?.commit_from_file(&path)?;
        println!("--- {model} ---");
        println!("inputs:");
        for input in session.inputs() {
            println!("  {:?}", input);
        }
        println!("outputs:");
        for output in session.outputs() {
            println!("  {:?}", output);
        }
        println!();
    }
    Ok(())
}
