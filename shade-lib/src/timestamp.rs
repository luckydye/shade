use crate::profiler::PassTiming;
use futures_channel::oneshot;
use wgpu::{
    Buffer, BufferDescriptor, BufferUsages, Device, QuerySet, QueryType, Queue,
    QUERY_RESOLVE_BUFFER_ALIGNMENT, QUERY_SIZE,
};

/// Manages a wgpu QuerySet for timestamp queries.
/// Each pass uses 2 timestamps: begin and end.
pub struct TimestampQueries {
    pub query_set: QuerySet,
    resolve_buf: Buffer,
    readback_buf: Buffer,
    pub capacity: u32, // number of passes (each uses 2 slots)
}

impl TimestampQueries {
    pub fn new(device: &Device, max_passes: u32) -> Self {
        let slots = max_passes * 2;
        let query_set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("shade_timestamps"),
            ty: QueryType::Timestamp,
            count: slots,
        });
        let resolve_size = (slots as u64) * (QUERY_SIZE as u64);
        // Align to QUERY_RESOLVE_BUFFER_ALIGNMENT
        let aligned_size = (resolve_size + QUERY_RESOLVE_BUFFER_ALIGNMENT - 1)
            & !(QUERY_RESOLVE_BUFFER_ALIGNMENT - 1);
        // Resolve buffer: GPU writes resolved timestamps here
        let resolve_buf = device.create_buffer(&BufferDescriptor {
            label: Some("timestamp_resolve"),
            size: aligned_size,
            usage: BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        // Readback buffer: CPU reads from here
        let readback_buf = device.create_buffer(&BufferDescriptor {
            label: Some("timestamp_readback"),
            size: aligned_size,
            usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        Self {
            query_set,
            resolve_buf,
            readback_buf,
            capacity: max_passes,
        }
    }

    /// Call at the end of all passes to resolve timestamps into the resolve buffer.
    pub fn resolve(&self, encoder: &mut wgpu::CommandEncoder, pass_count: u32) {
        let slots = pass_count * 2;
        encoder.resolve_query_set(&self.query_set, 0..slots, &self.resolve_buf, 0);
        encoder.copy_buffer_to_buffer(
            &self.resolve_buf,
            0,
            &self.readback_buf,
            0,
            (slots as u64) * (QUERY_SIZE as u64),
        );
    }

    /// Read back timing data. Must be called after the encoder is submitted and GPU work completes.
    /// `pass_names` should have length == `pass_count`.
    /// `timestamp_period`: nanoseconds per tick (from adapter info).
    pub async fn read_timings(
        &self,
        device: &Device,
        _queue: &Queue,
        pass_names: &[&str],
        timestamp_period: f32,
    ) -> Vec<PassTiming> {
        let pass_count = pass_names.len() as u32;
        let slots = pass_count * 2;
        let byte_len = (slots as u64) * (QUERY_SIZE as u64);

        let slice = self.readback_buf.slice(..byte_len);
        let (tx, rx) = oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        device.poll(wgpu::Maintain::Wait);
        let _ = rx.await;

        let data = slice.get_mapped_range();
        let timestamps: &[u64] = bytemuck::cast_slice(&data);
        let mut results = Vec::with_capacity(pass_names.len());
        for (i, name) in pass_names.iter().enumerate() {
            let t_begin = timestamps[i * 2];
            let t_end = timestamps[i * 2 + 1];
            let nanos =
                ((t_end.saturating_sub(t_begin)) as f32 * timestamp_period) as u64;
            results.push(PassTiming {
                name: name.to_string(),
                gpu_micros: nanos / 1000,
            });
        }
        drop(data);
        self.readback_buf.unmap();
        results
    }
}
