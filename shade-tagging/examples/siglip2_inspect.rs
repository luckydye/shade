use anyhow::Result;
use ort::session::Session;

fn main() -> Result<()> {
    let model_dir = std::env::args().nth(1).expect("model dir required");
    let session =
        Session::builder()?.commit_from_file(format!("{model_dir}/onnx/model_quantized.onnx"))?;
    println!("inputs:");
    for input in session.inputs() {
        println!("  {:?}", input);
    }
    println!("outputs:");
    for output in session.outputs() {
        println!("  {:?}", output);
    }
    Ok(())
}
