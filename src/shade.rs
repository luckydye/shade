//! Image processing pipeline with node-based architecture
//!
//! This module provides a flexible, extensible system for image processing
//! that mimics node-based compositing software like Blender's shader editor
//! or DaVinci Resolve's node graph.

use std::collections::HashMap;
use wgpu::{Device, Queue, Texture, TextureView, ComputePipeline};

/// Represents different types of image processing operations
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NodeType {
    // Input/Output nodes
    ImageInput,
    ImageOutput,

    // Color grading nodes
    Brightness,
    Contrast,
    Saturation,
    Hue,
    Gamma,
    Levels,
    ColorBalance,

    // Filters
    Blur,
    Sharpen,
    Noise,

    // Transformations
    Scale,
    Rotate,
    Crop,

    // Utility nodes
    Mix,
    Mask,
    Invert,
}

/// Parameters for different node types
#[derive(Debug, Clone)]
pub enum NodeParams {
    Brightness { value: f32 },
    Contrast { value: f32 },
    Saturation { value: f32 },
    Hue { value: f32 },
    Gamma { value: f32 },
    Levels {
        input_black: f32,
        input_white: f32,
        output_black: f32,
        output_white: f32
    },
    ColorBalance {
        shadows: [f32; 3],    // RGB
        midtones: [f32; 3],   // RGB
        highlights: [f32; 3]  // RGB
    },
    Blur { radius: f32 },
    Sharpen { amount: f32 },
    Noise { amount: f32, seed: u32 },
    Scale { factor: f32 },
    Rotate { angle: f32 },
    Crop { x: u32, y: u32, width: u32, height: u32 },
    Mix { factor: f32 },
    None,
}

/// Represents a connection between two nodes
#[derive(Debug, Clone)]
pub struct Connection {
    pub from_node: usize,
    pub to_node: usize,
    pub from_output: String,
    pub to_input: String,
}

/// A single processing node in the pipeline
#[derive(Debug, Clone)]
pub struct ProcessingNode {
    pub id: usize,
    pub name: String,
    pub node_type: NodeType,
    pub params: NodeParams,
    pub enabled: bool,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
}

impl ProcessingNode {
    pub fn new(id: usize, name: String, node_type: NodeType) -> Self {
        let (inputs, outputs) = match node_type {
            NodeType::ImageInput => (vec![], vec!["image".to_string()]),
            NodeType::ImageOutput => (vec!["image".to_string()], vec![]),
            NodeType::Mix => (vec!["image1".to_string(), "image2".to_string()], vec!["image".to_string()]),
            _ => (vec!["image".to_string()], vec!["image".to_string()]),
        };

        Self {
            id,
            name,
            node_type: node_type.clone(),
            params: Self::default_params(&node_type),
            enabled: true,
            inputs,
            outputs,
        }
    }

    fn default_params(node_type: &NodeType) -> NodeParams {
        match node_type {
            NodeType::Brightness => NodeParams::Brightness { value: 0.0 },
            NodeType::Contrast => NodeParams::Contrast { value: 1.0 },
            NodeType::Saturation => NodeParams::Saturation { value: 1.0 },
            NodeType::Hue => NodeParams::Hue { value: 0.0 },
            NodeType::Gamma => NodeParams::Gamma { value: 1.0 },
            NodeType::Levels => NodeParams::Levels {
                input_black: 0.0,
                input_white: 1.0,
                output_black: 0.0,
                output_white: 1.0
            },
            NodeType::ColorBalance => NodeParams::ColorBalance {
                shadows: [1.0, 1.0, 1.0],
                midtones: [1.0, 1.0, 1.0],
                highlights: [1.0, 1.0, 1.0],
            },
            NodeType::Blur => NodeParams::Blur { radius: 1.0 },
            NodeType::Sharpen => NodeParams::Sharpen { amount: 1.0 },
            NodeType::Noise => NodeParams::Noise { amount: 0.1, seed: 42 },
            NodeType::Scale => NodeParams::Scale { factor: 1.0 },
            NodeType::Rotate => NodeParams::Rotate { angle: 0.0 },
            NodeType::Crop => NodeParams::Crop { x: 0, y: 0, width: 512, height: 512 },
            NodeType::Mix => NodeParams::Mix { factor: 0.5 },
            _ => NodeParams::None,
        }
    }

    /// Update node parameters
    pub fn set_params(&mut self, params: NodeParams) {
        self.params = params;
    }

    /// Enable or disable the node
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
}

/// The main image processing pipeline
pub struct ImagePipeline {
    pub nodes: HashMap<usize, ProcessingNode>,
    pub connections: Vec<Connection>,
    pub input_node_id: Option<usize>,
    pub output_node_id: Option<usize>,
    next_node_id: usize,

    // GPU resources
    device: Option<Device>,
    queue: Option<Queue>,
    pipelines: HashMap<NodeType, ComputePipeline>,
    textures: HashMap<usize, Texture>,
    texture_views: HashMap<usize, TextureView>,
}

impl ImagePipeline {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            connections: Vec::new(),
            input_node_id: None,
            output_node_id: None,
            next_node_id: 0,
            device: None,
            queue: None,
            pipelines: HashMap::new(),
            textures: HashMap::new(),
            texture_views: HashMap::new(),
        }
    }

    /// Initialize GPU resources
    pub fn init_gpu(&mut self, device: Device, queue: Queue) {
        self.device = Some(device);
        self.queue = Some(queue);

        // Store device reference to avoid borrow checker issues
        if let Some(device) = &self.device {
            let pipelines = Self::create_compute_pipelines(device);
            self.pipelines = pipelines;
        }
    }

    fn create_compute_pipelines(device: &Device) -> HashMap<NodeType, ComputePipeline> {
        let mut pipelines = HashMap::new();
        // Create bind group layout for image processing shaders
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Image Processing Bind Group Layout"),
            entries: &[
                // Input texture
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Output texture
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                // Parameters uniform buffer
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Image Processing Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        // Initialize pipelines for each node type that needs GPU processing
        let node_types_to_initialize = [
            NodeType::Brightness,
            NodeType::Contrast,
            NodeType::Saturation,
            NodeType::Hue,
            NodeType::Gamma,
            NodeType::Levels,
            NodeType::ColorBalance,
            NodeType::Blur,
            NodeType::Sharpen,
            NodeType::Noise,
            NodeType::Scale,
            NodeType::Rotate,
            NodeType::Crop,
            NodeType::Mix,
            NodeType::Mask,
            NodeType::Invert,
        ];

        for node_type in &node_types_to_initialize {
            if let Some(shader_source) = Self::get_shader_source_for_node_type(node_type) {
                let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(&format!("{:?} Shader", node_type)),
                    source: wgpu::ShaderSource::Wgsl(shader_source.into()),
                });

                let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(&format!("{:?} Pipeline", node_type)),
                    layout: Some(&pipeline_layout),
                    module: &shader_module,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                });

                pipelines.insert(*node_type, pipeline);
            }
        }

        pipelines
    }

    fn get_shader_source_for_node_type(node_type: &NodeType) -> Option<&'static str> {
        match node_type {
            NodeType::Brightness => Some(include_str!("shaders/brightness.wgsl")),
            NodeType::Contrast => Some(include_str!("shaders/contrast.wgsl")),
            NodeType::Saturation => Some(include_str!("shaders/saturation.wgsl")),
            NodeType::Hue => Some(include_str!("shaders/hue.wgsl")),
            NodeType::Gamma => Some(include_str!("shaders/gamma.wgsl")),
            NodeType::Levels => Some(include_str!("shaders/levels.wgsl")),
            NodeType::ColorBalance => Some(include_str!("shaders/color_balance.wgsl")),
            NodeType::Blur => Some(include_str!("shaders/blur.wgsl")),
            NodeType::Sharpen => Some(include_str!("shaders/sharpen.wgsl")),
            NodeType::Noise => Some(include_str!("shaders/noise.wgsl")),
            NodeType::Scale => Some(include_str!("shaders/scale.wgsl")),
            NodeType::Rotate => Some(include_str!("shaders/rotate.wgsl")),
            NodeType::Crop => Some(include_str!("shaders/crop.wgsl")),
            NodeType::Mix => Some(include_str!("shaders/mix.wgsl")),
            NodeType::Mask => Some(include_str!("shaders/mask.wgsl")),
            NodeType::Invert => Some(include_str!("shaders/invert.wgsl")),
            // ImageInput and ImageOutput don't need compute shaders
            NodeType::ImageInput | NodeType::ImageOutput => None,
        }
    }

    /// Add a new node to the pipeline
    pub fn add_node(&mut self, name: String, node_type: NodeType) -> usize {
        let id = self.next_node_id;
        self.next_node_id += 1;

        let node = ProcessingNode::new(id, name, node_type.clone());

        // Set input/output node references
        match node_type {
            NodeType::ImageInput => self.input_node_id = Some(id),
            NodeType::ImageOutput => self.output_node_id = Some(id),
            _ => {}
        }

        self.nodes.insert(id, node);
        id
    }

    /// Remove a node from the pipeline
    pub fn remove_node(&mut self, node_id: usize) -> Result<(), String> {
        if !self.nodes.contains_key(&node_id) {
            return Err(format!("Node {} does not exist", node_id));
        }

        // Remove all connections involving this node
        self.connections.retain(|conn| {
            conn.from_node != node_id && conn.to_node != node_id
        });

        // Clear input/output references if necessary
        if self.input_node_id == Some(node_id) {
            self.input_node_id = None;
        }
        if self.output_node_id == Some(node_id) {
            self.output_node_id = None;
        }

        self.nodes.remove(&node_id);
        Ok(())
    }

    /// Connect two nodes
    pub fn connect_nodes(
        &mut self,
        from_node: usize,
        from_output: String,
        to_node: usize,
        to_input: String
    ) -> Result<(), String> {
        // Validate nodes exist
        if !self.nodes.contains_key(&from_node) {
            return Err(format!("Source node {} does not exist", from_node));
        }
        if !self.nodes.contains_key(&to_node) {
            return Err(format!("Target node {} does not exist", to_node));
        }

        // Validate outputs and inputs exist
        let from_node_ref = &self.nodes[&from_node];
        let to_node_ref = &self.nodes[&to_node];

        if !from_node_ref.outputs.contains(&from_output) {
            return Err(format!("Output '{}' does not exist on node {}", from_output, from_node));
        }
        if !to_node_ref.inputs.contains(&to_input) {
            return Err(format!("Input '{}' does not exist on node {}", to_input, to_node));
        }

        // Check for cycles (basic check)
        if self.would_create_cycle(from_node, to_node) {
            return Err("Connection would create a cycle".to_string());
        }

        // Remove existing connection to the same input
        self.connections.retain(|conn| {
            !(conn.to_node == to_node && conn.to_input == to_input)
        });

        // Add new connection
        self.connections.push(Connection {
            from_node,
            to_node,
            from_output,
            to_input,
        });

        Ok(())
    }

    /// Basic cycle detection
    fn would_create_cycle(&self, from: usize, to: usize) -> bool {
        // Simple check: if 'to' can reach 'from', adding this connection creates a cycle
        self.can_reach(to, from)
    }

    /// Check if one node can reach another through connections
    fn can_reach(&self, from: usize, target: usize) -> bool {
        if from == target {
            return true;
        }

        for conn in &self.connections {
            if conn.from_node == from && self.can_reach(conn.to_node, target) {
                return true;
            }
        }
        false
    }

    /// Get execution order using topological sort
    pub fn get_execution_order(&self) -> Result<Vec<usize>, String> {
        let mut in_degree: HashMap<usize, usize> = HashMap::new();
        let mut graph: HashMap<usize, Vec<usize>> = HashMap::new();

        // Initialize
        for &node_id in self.nodes.keys() {
            in_degree.insert(node_id, 0);
            graph.insert(node_id, Vec::new());
        }

        // Build graph and count in-degrees
        for conn in &self.connections {
            graph.entry(conn.from_node).or_default().push(conn.to_node);
            *in_degree.entry(conn.to_node).or_default() += 1;
        }

        // Topological sort
        let mut queue: Vec<usize> = in_degree
            .iter()
            .filter(|(_, degree)| **degree == 0)
            .map(|(node_id, _)| *node_id)
            .collect();

        let mut result = Vec::new();

        while let Some(node_id) = queue.pop() {
            result.push(node_id);

            if let Some(neighbors) = graph.get(&node_id) {
                for &neighbor in neighbors {
                    if let Some(degree) = in_degree.get_mut(&neighbor) {
                        *degree -= 1;
                        if *degree == 0 {
                            queue.push(neighbor);
                        }
                    }
                }
            }
        }

        if result.len() != self.nodes.len() {
            return Err("Cycle detected in pipeline".to_string());
        }

        Ok(result)
    }

    /// Process the entire pipeline
    pub async fn process(&mut self, input_data: Vec<u8>, _dimensions: (u32, u32)) -> Result<Vec<u8>, String> {
        let execution_order = self.get_execution_order()?;

        // TODO: Implement actual GPU processing
        // For now, return the input data unchanged
        log::info!("Processing pipeline with {} nodes", execution_order.len());
        for &node_id in &execution_order {
            if let Some(node) = self.nodes.get(&node_id) {
                if node.enabled {
                    log::info!("Processing node: {} ({})", node.name, node.id);
                    // TODO: Execute node-specific compute shader

                    // For now, just log the parameters
                    log::info!("Node params: {:?}", node.params);
                }
            }
        }

        Ok(input_data)
    }

    /// Get node by ID
    pub fn get_node(&self, node_id: usize) -> Option<&ProcessingNode> {
        self.nodes.get(&node_id)
    }

    /// Get mutable node by ID
    pub fn get_node_mut(&mut self, node_id: usize) -> Option<&mut ProcessingNode> {
        self.nodes.get_mut(&node_id)
    }

    /// List all nodes
    pub fn list_nodes(&self) -> Vec<&ProcessingNode> {
        self.nodes.values().collect()
    }

    /// Clear the entire pipeline
    pub fn clear(&mut self) {
        self.nodes.clear();
        self.connections.clear();
        self.input_node_id = None;
        self.output_node_id = None;
        self.next_node_id = 0;
    }

    /// Validate the pipeline
    pub fn validate(&self) -> Result<(), String> {
        // Check for input and output nodes
        if self.input_node_id.is_none() {
            return Err("Pipeline must have an input node".to_string());
        }
        if self.output_node_id.is_none() {
            return Err("Pipeline must have an output node".to_string());
        }

        // Check execution order (also validates no cycles)
        self.get_execution_order()?;

        Ok(())
    }
}

impl Default for ImagePipeline {
    fn default() -> Self {
        Self::new()
    }
}

/// Builder pattern for creating common pipeline configurations
pub struct PipelineBuilder {
    pipeline: ImagePipeline,
}

impl PipelineBuilder {
    pub fn new() -> Self {
        Self {
            pipeline: ImagePipeline::new(),
        }
    }

    /// Create a basic color grading pipeline
    pub fn basic_color_grading(mut self) -> Self {
        let input_id = self.pipeline.add_node("Input".to_string(), NodeType::ImageInput);
        let brightness_id = self.pipeline.add_node("Brightness".to_string(), NodeType::Brightness);
        let contrast_id = self.pipeline.add_node("Contrast".to_string(), NodeType::Contrast);
        let saturation_id = self.pipeline.add_node("Saturation".to_string(), NodeType::Saturation);
        let output_id = self.pipeline.add_node("Output".to_string(), NodeType::ImageOutput);

        // Connect nodes in sequence
        self.pipeline.connect_nodes(input_id, "image".to_string(), brightness_id, "image".to_string()).unwrap();
        self.pipeline.connect_nodes(brightness_id, "image".to_string(), contrast_id, "image".to_string()).unwrap();
        self.pipeline.connect_nodes(contrast_id, "image".to_string(), saturation_id, "image".to_string()).unwrap();
        self.pipeline.connect_nodes(saturation_id, "image".to_string(), output_id, "image".to_string()).unwrap();

        self
    }

    /// Add a blur filter to the pipeline
    pub fn with_blur(mut self, radius: f32) -> Self {
        let blur_id = self.pipeline.add_node("Blur".to_string(), NodeType::Blur);
        if let Some(node) = self.pipeline.get_node_mut(blur_id) {
            node.set_params(NodeParams::Blur { radius });
        }
        self
    }

    /// Build the final pipeline
    pub fn build(self) -> ImagePipeline {
        self.pipeline
    }
}

impl Default for PipelineBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_creation() {
        let node = ProcessingNode::new(0, "Test".to_string(), NodeType::Brightness);
        assert_eq!(node.id, 0);
        assert_eq!(node.name, "Test");
        assert_eq!(node.node_type, NodeType::Brightness);
        assert!(node.enabled);
    }

    #[test]
    fn test_pipeline_creation() {
        let mut pipeline = ImagePipeline::new();
        let node_id = pipeline.add_node("Test".to_string(), NodeType::Brightness);
        assert_eq!(node_id, 0);
        assert!(pipeline.nodes.contains_key(&0));
    }

    #[test]
    fn test_node_connection() {
        let mut pipeline = ImagePipeline::new();
        let input_id = pipeline.add_node("Input".to_string(), NodeType::ImageInput);
        let output_id = pipeline.add_node("Output".to_string(), NodeType::ImageOutput);

        let result = pipeline.connect_nodes(
            input_id,
            "image".to_string(),
            output_id,
            "image".to_string()
        );

        assert!(result.is_ok());
        assert_eq!(pipeline.connections.len(), 1);
    }

    #[test]
    fn test_execution_order() {
        let mut pipeline = ImagePipeline::new();
        let input_id = pipeline.add_node("Input".to_string(), NodeType::ImageInput);
        let brightness_id = pipeline.add_node("Brightness".to_string(), NodeType::Brightness);
        let output_id = pipeline.add_node("Output".to_string(), NodeType::ImageOutput);

        pipeline.connect_nodes(input_id, "image".to_string(), brightness_id, "image".to_string()).unwrap();
        pipeline.connect_nodes(brightness_id, "image".to_string(), output_id, "image".to_string()).unwrap();

        let order = pipeline.get_execution_order().unwrap();
        assert_eq!(order.len(), 3);
        assert_eq!(order[0], input_id);
        assert_eq!(order[2], output_id);
    }

    #[test]
    fn test_pipeline_builder() {
        let pipeline = PipelineBuilder::new()
            .basic_color_grading()
            .build();

        assert_eq!(pipeline.nodes.len(), 5);
        assert!(pipeline.input_node_id.is_some());
        assert!(pipeline.output_node_id.is_some());
    }
}
