use std::collections::{HashMap, VecDeque};
use std::sync::{Condvar, Mutex};

pub struct ThumbnailJob<Response> {
    pub path: String,
    pub response: Response,
}

pub struct PendingThumbnailJob<Response> {
    pub path: String,
    pub responses: Vec<Response>,
}

pub struct ThumbnailQueue<Response> {
    pub jobs: Mutex<(VecDeque<String>, HashMap<String, Vec<Response>>)>,
    pub has_jobs: Condvar,
}

impl<Response> ThumbnailQueue<Response> {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new((VecDeque::new(), HashMap::new())),
            has_jobs: Condvar::new(),
        }
    }

    pub fn push(&self, job: ThumbnailJob<Response>) {
        let mut jobs = self.jobs.lock().expect("thumbnail queue lock poisoned");
        let (order, pending) = &mut *jobs;
        if let Some(responses) = pending.get_mut(&job.path) {
            responses.push(job.response);
            if let Some(existing_idx) = order.iter().position(|path| path == &job.path) {
                order.remove(existing_idx);
            }
            order.push_back(job.path);
        } else {
            pending.insert(job.path.clone(), vec![job.response]);
            order.push_back(job.path);
        }
        self.has_jobs.notify_one();
    }

    pub fn pop_latest(&self) -> PendingThumbnailJob<Response> {
        let mut jobs = self.jobs.lock().expect("thumbnail queue lock poisoned");
        loop {
            let (order, pending) = &mut *jobs;
            if let Some(path) = order.pop_back() {
                let responses = pending
                    .remove(&path)
                    .expect("thumbnail queue pending entry must exist");
                return PendingThumbnailJob { path, responses };
            }
            jobs = self
                .has_jobs
                .wait(jobs)
                .expect("thumbnail queue lock poisoned");
        }
    }
}
