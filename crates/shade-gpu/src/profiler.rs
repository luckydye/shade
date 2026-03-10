use std::collections::VecDeque;

/// Records timing for one named GPU pass.
#[derive(Debug, Clone)]
pub struct PassTiming {
    pub name: String,
    pub gpu_micros: u64,
}

/// Rolling history of frame timings (last N frames).
pub struct GpuProfiler {
    pub enabled: bool,
    /// Timestamps supported by the adapter
    pub timestamp_period: f32,
    history: VecDeque<Vec<PassTiming>>,
    capacity: usize,
}

impl GpuProfiler {
    pub fn new(timestamp_period: f32, capacity: usize) -> Self {
        Self {
            enabled: true,
            timestamp_period,
            history: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    /// Record a completed frame's timings.
    pub fn push_frame(&mut self, timings: Vec<PassTiming>) {
        if self.history.len() == self.capacity {
            self.history.pop_front();
        }
        self.history.push_back(timings);
    }

    /// Average GPU time per pass over the recorded history.
    pub fn averages(&self) -> Vec<PassTiming> {
        if self.history.is_empty() {
            return vec![];
        }
        // Collect all pass names from the most recent frame
        let Some(last) = self.history.back() else { return vec![]; };
        last.iter().map(|p| {
            let sum: u64 = self.history.iter()
                .filter_map(|frame| frame.iter().find(|t| t.name == p.name))
                .map(|t| t.gpu_micros)
                .sum();
            let count = self.history.len() as u64;
            PassTiming { name: p.name.clone(), gpu_micros: sum / count }
        }).collect()
    }

    /// Print a summary to stderr.
    pub fn print_summary(&self) {
        let avgs = self.averages();
        if avgs.is_empty() { return; }
        let total: u64 = avgs.iter().map(|t| t.gpu_micros).sum();
        eprintln!("── GPU Profiler ──────────────────────");
        for t in &avgs {
            eprintln!("  {:.<30} {:>6} µs", t.name, t.gpu_micros);
        }
        eprintln!("  {:.<30} {:>6} µs", "TOTAL", total);
        eprintln!("─────────────────────────────────────");
    }
}
