use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};

use gpui::{
    canvas, div, img, px, rgb, size, App, AppContext, Application, Bounds, ClickEvent, Context,
    Entity, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, RenderImage, SharedString, StatefulInteractiveElement, Styled,
    TitlebarOptions, Window, WindowBounds, WindowOptions,
};
use image::{imageops::FilterType, Frame, ImageBuffer, RgbaImage};
use shade_lib::{AdjustmentOp, ColorParams, Renderer};
use smallvec::SmallVec;

// ── Render worker thread ─────────────────────────────────────────────────────
//
// Renderer contains RefCell so it is !Send. We keep it on a dedicated OS
// thread and communicate via a "latest-job-wins" slot: the UI overwrites any
// pending job before the thread picks it up, so rapid slider moves only ever
// process the most-recently-requested frame.

struct RenderJob {
    pixels: Arc<Vec<u8>>,
    w: u32,
    h: u32,
    ops: Vec<AdjustmentOp>,
    reply: futures_channel::oneshot::Sender<anyhow::Result<Vec<u8>>>,
}

struct JobSlot {
    job: Mutex<Option<RenderJob>>,
    wake: Condvar,
}

#[derive(Clone)]
struct RenderWorker(Arc<JobSlot>);

impl RenderWorker {
    fn new() -> Self {
        let slot = Arc::new(JobSlot {
            job: Mutex::new(None),
            wake: Condvar::new(),
        });
        let slot2 = slot.clone();
        std::thread::spawn(move || {
            let renderer = pollster::block_on(Renderer::new())
                .expect("failed to create shade-lib Renderer on render thread");
            loop {
                let job: RenderJob = {
                    let mut guard = slot2.job.lock().unwrap();
                    loop {
                        match guard.take() {
                            Some(j) => break j,
                            None => guard = slot2.wake.wait(guard).unwrap(),
                        }
                    }
                };
                let result = pollster::block_on(renderer.render_with_ops(
                    &job.pixels,
                    job.w,
                    job.h,
                    &job.ops,
                ));
                let _ = job.reply.send(result);
            }
        });
        Self(slot)
    }

    /// Submit a job. If a previous job is still waiting, it is discarded.
    fn submit(&self, job: RenderJob) {
        *self.0.job.lock().unwrap() = Some(job);
        self.0.wake.notify_one();
    }
}

// ── State ────────────────────────────────────────────────────────────────────

const PREVIEW_MAX_DIM: u32 = 1200;
const THUMB_MAX_DIM: u32 = 240;

struct Photo {
    path: PathBuf,
    name: SharedString,
    preview_rgba: Arc<Vec<u8>>,
    preview_w: u32,
    preview_h: u32,
    thumb: Arc<RenderImage>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Library,
    Editor,
}

#[derive(Clone, Copy, Debug)]
struct Edits {
    exposure: f32,    // -3..3 EV
    contrast: f32,    // -1..1
    saturation: f32,  // -1..1
    vibrancy: f32,    // -1..1
    temperature: f32, // -1..1
}

impl Edits {
    fn zero() -> Self {
        Self { exposure: 0.0, contrast: 0.0, saturation: 0.0, vibrancy: 0.0, temperature: 0.0 }
    }

    fn to_ops(self) -> Vec<AdjustmentOp> {
        let mut ops = Vec::new();
        if self.exposure != 0.0 || self.contrast != 0.0 {
            ops.push(AdjustmentOp::Tone {
                exposure: self.exposure,
                contrast: self.contrast,
                blacks: 0.0, whites: 0.0, highlights: 0.0, shadows: 0.0, gamma: 1.0,
            });
        }
        if self.saturation != 0.0 || self.vibrancy != 0.0 || self.temperature != 0.0 {
            ops.push(AdjustmentOp::Color(ColorParams {
                saturation: self.saturation,
                vibrancy: self.vibrancy,
                temperature: self.temperature,
                tint: 0.0,
            }));
        }
        ops
    }
}

#[derive(Clone, Copy, PartialEq)]
enum SliderField {
    Exposure, Contrast, Saturation, Vibrancy, Temperature,
}

struct SliderDrag {
    field: SliderField,
    start_x: f32,
    start_val: f32,
    track_width: f32,
}

struct Shade {
    worker: RenderWorker,
    photos: Vec<Photo>,
    selected: Option<usize>,
    view: View,
    edits: Edits,
    rendered: Option<Arc<RenderImage>>,
    // Images evicted from `rendered` that still need to be removed from the
    // sprite atlas. Drained in render() where &mut Window is available.
    pending_drops: Vec<Arc<RenderImage>>,
    status: Option<SharedString>,
    drag: Option<SliderDrag>,
    // Dropping cancels awaiting the previous result (render thread discards it too).
    _render_task: Option<gpui::Task<()>>,
}

impl Shade {
    fn new(worker: RenderWorker) -> Self {
        Self {
            worker,
            photos: Vec::new(),
            selected: None,
            view: View::Library,
            edits: Edits::zero(),
            rendered: None,
            pending_drops: Vec::new(),
            status: None,
            drag: None,
            _render_task: None,
        }
    }

    /// Replace `self.rendered`, queuing the old image for atlas eviction.
    fn set_rendered(&mut self, new: Option<Arc<RenderImage>>) {
        if let Some(old) = std::mem::replace(&mut self.rendered, new) {
            self.pending_drops.push(old);
        }
    }

    fn open_picker(&mut self, cx: &mut Context<Self>) {
        let files = rfd::FileDialog::new()
            .add_filter("Image", &["jpg","jpeg","png","webp","tif","tiff","exr","dng","cr3","arw","nef"])
            .pick_files();
        let Some(files) = files else { return };
        for path in files {
            match load_photo(&path) {
                Ok(photo) => self.photos.push(photo),
                Err(e) => self.status = Some(SharedString::from(
                    format!("Failed to open {}: {}", path.display(), e)
                )),
            }
        }
        if self.selected.is_none() {
            self.selected = self.photos.len().checked_sub(1);
        }
        cx.notify();
    }

    fn open_editor(&mut self, idx: usize, cx: &mut Context<Self>) {
        self.selected = Some(idx);
        self.view = View::Editor;
        self.edits = Edits::zero();
        self.rerender(cx);
    }

    fn set_view(&mut self, view: View, cx: &mut Context<Self>) {
        if matches!(view, View::Editor) && self.selected.is_none() { return; }
        self.view = view;
        if matches!(view, View::Editor) && self.rendered.is_none() {
            self.rerender(cx);
        } else {
            cx.notify();
        }
    }

    fn set_field(&mut self, field: SliderField, val: f32, cx: &mut Context<Self>) {
        match field {
            SliderField::Exposure    => self.edits.exposure    = val.clamp(-3.0, 3.0),
            SliderField::Contrast    => self.edits.contrast    = val.clamp(-1.0, 1.0),
            SliderField::Saturation  => self.edits.saturation  = val.clamp(-1.0, 1.0),
            SliderField::Vibrancy    => self.edits.vibrancy    = val.clamp(-1.0, 1.0),
            SliderField::Temperature => self.edits.temperature = val.clamp(-1.0, 1.0),
        }
        self.rerender(cx);
    }

    fn reset(&mut self, cx: &mut Context<Self>) {
        self.edits = Edits::zero();
        self.rerender(cx);
    }

    fn rerender(&mut self, cx: &mut Context<Self>) {
        let Some(idx) = self.selected else {
            self.set_rendered(None);
            self._render_task = None;
            cx.notify();
            return;
        };
        let photo = &self.photos[idx];
        let pixels = photo.preview_rgba.clone();
        let w = photo.preview_w;
        let h = photo.preview_h;
        let ops = self.edits.to_ops();

        let (tx, rx) = futures_channel::oneshot::channel();

        if ops.is_empty() {
            // No edits: pass through without touching the render thread.
            let bytes = pixels.as_ref().clone();
            self.set_rendered(render_image_from_rgba(bytes, w, h));
            self._render_task = None;
            cx.notify();
        } else {
            self.worker.submit(RenderJob { pixels, w, h, ops, reply: tx });
            // Await the reply on the foreground executor (non-blocking).
            // Must use async closure (not a closure calling async fn) to satisfy
            // the AsyncFnOnce HRTB bound on cx.spawn.
            self._render_task = Some(cx.spawn(async move |weak_this, cx| {
                let result = rx.await.unwrap_or_else(|_| Err(anyhow::anyhow!("cancelled")));
                cx.update(|app| {
                    weak_this.update(app, |this: &mut Shade, cx| {
                        match result {
                            Ok(bytes) => { this.set_rendered(render_image_from_rgba(bytes, w, h)); }
                            Err(e) => { this.status = Some(SharedString::from(format!("Render failed: {e}"))); }
                        }
                        cx.notify();
                    }).ok();
                }).ok();
            }));
        }
    }

    fn save_as(&mut self, cx: &mut Context<Self>) {
        let Some(idx) = self.selected else { return };
        let path = rfd::FileDialog::new()
            .add_filter("PNG", &["png"])
            .add_filter("JPEG", &["jpg"])
            .set_file_name(format!(
                "{}-edited.png",
                self.photos[idx].path.file_stem().and_then(|s| s.to_str()).unwrap_or("export")
            ))
            .save_file();
        let Some(path) = path else { return };
        let photo = &self.photos[idx];
        let ops = self.edits.to_ops();
        let bytes = if ops.is_empty() {
            photo.preview_rgba.as_ref().clone()
        } else {
            match pollster::block_on(Renderer::new()).and_then(|r| {
                pollster::block_on(r.render_with_ops(&photo.preview_rgba, photo.preview_w, photo.preview_h, &ops))
            }) {
                Ok(b) => b,
                Err(e) => {
                    self.status = Some(SharedString::from(format!("Export render failed: {e}")));
                    cx.notify(); return;
                }
            }
        };
        match shade_io::save_image(&path, &bytes, photo.preview_w, photo.preview_h) {
            Ok(()) => self.status = Some(SharedString::from(format!("Saved {}", path.display()))),
            Err(e) => self.status = Some(SharedString::from(format!("Save failed: {e}"))),
        }
        cx.notify();
    }
}

// ── Loading helpers ──────────────────────────────────────────────────────────

fn load_photo(path: &std::path::Path) -> anyhow::Result<Photo> {
    let (pixels, w, h) = shade_io::load_image(path)?;
    let (preview_pixels, pw, ph) = fit_within(&pixels, w, h, PREVIEW_MAX_DIM);
    let (thumb_pixels, tw, th) = fit_within(&preview_pixels, pw, ph, THUMB_MAX_DIM);
    let thumb = render_image_from_rgba(thumb_pixels, tw, th)
        .ok_or_else(|| anyhow::anyhow!("thumbnail build failed"))?;
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("image").to_string();
    Ok(Photo {
        path: path.to_path_buf(),
        name: SharedString::from(name),
        preview_rgba: Arc::new(preview_pixels),
        preview_w: pw,
        preview_h: ph,
        thumb,
    })
}

fn fit_within(rgba: &[u8], w: u32, h: u32, max_dim: u32) -> (Vec<u8>, u32, u32) {
    let m = w.max(h);
    if m <= max_dim { return (rgba.to_vec(), w, h); }
    let scale = max_dim as f32 / m as f32;
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    let img: RgbaImage = ImageBuffer::from_raw(w, h, rgba.to_vec()).unwrap();
    let resized = image::imageops::resize(&img, nw, nh, FilterType::Triangle);
    (resized.into_raw(), nw, nh)
}

fn render_image_from_rgba(mut rgba: Vec<u8>, w: u32, h: u32) -> Option<Arc<RenderImage>> {
    if rgba.len() != w as usize * h as usize * 4 { return None; }
    for px in rgba.chunks_exact_mut(4) { px.swap(0, 2); }
    let buf: RgbaImage = ImageBuffer::from_raw(w, h, rgba)?;
    Some(Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(buf), 1))))
}

// ── Theme ────────────────────────────────────────────────────────────────────

const BG: u32 = 0x141414;
const PANEL: u32 = 0x1c1c1e;
const BORDER: u32 = 0x2c2c2e;
const TEXT: u32 = 0xeeeeee;
const MUTED: u32 = 0x9a9a9a;
const ACCENT: u32 = 0x4f8cff;

// ── Slider ───────────────────────────────────────────────────────────────────

fn slider(
    field: SliderField,
    label: &'static str,
    value: f32,
    min: f32,
    max: f32,
    entity: Entity<Shade>,
) -> impl IntoElement {
    let frac = ((value - min) / (max - min)).clamp(0.0, 1.0);
    let val_text = if field == SliderField::Exposure {
        format!("{:+.2} ev", value)
    } else {
        format!("{:+.2}", value)
    };

    div()
        .flex().flex_col().gap_1()
        .child(
            div().flex().flex_row().justify_between()
                .child(div().text_color(rgb(MUTED)).child(label))
                .child(div().text_color(rgb(TEXT)).child(val_text)),
        )
        .child(
            div()
                .id(SharedString::from(format!("slider-{}", label)))
                .relative()
                .w_full()
                .h(px(6.0))
                .rounded_full()
                .bg(rgb(0x3a3a3c))
                .child(
                    div()
                        .absolute().left(px(0.0)).top(px(0.0))
                        .h(px(6.0))
                        .w(gpui::relative(frac))
                        .rounded_full()
                        .bg(rgb(ACCENT)),
                )
                .child(
                    canvas(
                        move |_, _, _| (),
                        {
                            let entity = entity.clone();
                            move |track_bounds, _, window, _| {
                                let entity_down = entity.clone();
                                let entity_move = entity.clone();
                                let entity_up   = entity.clone();
                                window.on_mouse_event(move |ev: &MouseDownEvent, _, _, cx| {
                                    if ev.button != MouseButton::Left
                                        || !track_bounds.contains(&ev.position) { return; }
                                    entity_down.update(cx, |this, cx| {
                                        let t = ((f32::from(ev.position.x) - f32::from(track_bounds.origin.x))
                                            / f32::from(track_bounds.size.width)).clamp(0.0, 1.0);
                                        let val = min + t * (max - min);
                                        this.drag = Some(SliderDrag {
                                            field,
                                            start_x: f32::from(ev.position.x),
                                            start_val: val,
                                            track_width: f32::from(track_bounds.size.width),
                                        });
                                        this.set_field(field, val, cx);
                                    });
                                });
                                window.on_mouse_event(move |ev: &MouseMoveEvent, _, _, cx| {
                                    if !ev.dragging() { return; }
                                    entity_move.update(cx, |this, cx| {
                                        let Some(ref d) = this.drag else { return };
                                        if d.field != field { return; }
                                        let dx = f32::from(ev.position.x) - d.start_x;
                                        let val = d.start_val + dx / d.track_width * (max - min);
                                        this.set_field(field, val, cx);
                                    });
                                });
                                window.on_mouse_event(move |_: &MouseUpEvent, _, _, cx| {
                                    entity_up.update(cx, |this, _| {
                                        if let Some(ref d) = this.drag {
                                            if d.field == field { this.drag = None; }
                                        }
                                    });
                                });
                            }
                        },
                    )
                    .absolute().inset_0().cursor_ew_resize(),
                ),
        )
}

// ── Header / buttons ─────────────────────────────────────────────────────────

fn header(view: View, has_image: bool, cx: &mut Context<Shade>) -> impl IntoElement {
    div()
        .flex().flex_row().items_center().justify_between()
        .px_4().py_3()
        .bg(rgb(PANEL)).border_b_1().border_color(rgb(BORDER))
        .child(div().text_color(rgb(TEXT)).child("Shade"))
        .child(
            div().flex().gap_2()
                .child(tab("Library", view == View::Library,
                    cx.listener(|this, _: &ClickEvent, _, cx| this.set_view(View::Library, cx))))
                .child(tab("Editor", view == View::Editor,
                    cx.listener(|this, _: &ClickEvent, _, cx| this.set_view(View::Editor, cx)))),
        )
        .child(
            div().flex().gap_2()
                .child(primary_button("Open…",
                    cx.listener(|this, _: &ClickEvent, _, cx| this.open_picker(cx))))
                .child(if has_image {
                    primary_button("Save Edited…",
                        cx.listener(|this, _: &ClickEvent, _, cx| this.save_as(cx))
                    ).into_any_element()
                } else { div().into_any_element() }),
        )
}

fn tab(label: &'static str, active: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> impl IntoElement {
    div().id(label).px_3().py_1().rounded_md()
        .text_color(rgb(if active { TEXT } else { MUTED }))
        .bg(rgb(if active { 0x2c2c2e } else { PANEL }))
        .hover(|s| s.bg(rgb(0x333336))).cursor_pointer().child(label).on_click(on_click)
}

fn primary_button(label: &'static str,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> impl IntoElement {
    div().id(label).px_3().py_1().rounded_md()
        .bg(rgb(ACCENT)).text_color(rgb(0x0b0b0b))
        .hover(|s| s.bg(rgb(0x6fa3ff))).cursor_pointer().child(label).on_click(on_click)
}

fn secondary_button(label: &'static str,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> impl IntoElement {
    div().id(label).px_3().py_1().rounded_md()
        .bg(rgb(0x2c2c2e)).text_color(rgb(TEXT))
        .hover(|s| s.bg(rgb(0x3a3a3c))).cursor_pointer().child(label).on_click(on_click)
}

// ── Views ────────────────────────────────────────────────────────────────────

impl Shade {
    fn render_library(&self, cx: &mut Context<Self>) -> impl IntoElement {
        if self.photos.is_empty() {
            return div()
                .size_full().flex().items_center().justify_center().flex_col().gap_3()
                .child(div().text_color(rgb(MUTED)).child("No images loaded."))
                .child(primary_button("Open Image…",
                    cx.listener(|this, _: &ClickEvent, _, cx| this.open_picker(cx))))
                .into_any_element();
        }
        let mut grid = div()
            .id("library-grid")
            .flex().flex_row().flex_wrap().gap_3().p_4().size_full()
            .overflow_y_scroll();
        for (i, photo) in self.photos.iter().enumerate() {
            let is_selected = self.selected == Some(i);
            let name = photo.name.clone();
            let thumb = photo.thumb.clone();
            let tile = div()
                .id(("tile", i))
                .w(px(220.0)).h(px(200.0))
                .flex().flex_col().rounded_md().overflow_hidden()
                .border_2().border_color(rgb(if is_selected { ACCENT } else { BORDER }))
                .cursor_pointer().hover(|s| s.border_color(rgb(ACCENT)))
                .child(
                    div().flex_1().bg(rgb(0x0e0e0e)).flex().items_center().justify_center()
                        .child(img(thumb).max_w_full().max_h_full()),
                )
                .child(div().px_2().py_1().bg(rgb(PANEL)).text_color(rgb(TEXT)).child(name))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.open_editor(i, cx)));
            grid = grid.child(tile);
        }
        grid.into_any_element()
    }

    fn render_editor(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self.selected.and_then(|i| self.photos.get(i))
            .map(|p| p.name.clone())
            .unwrap_or_else(|| SharedString::from("(no image)"));

        let preview_inner: gpui::AnyElement = match &self.rendered {
            Some(ri) => img(ri.clone()).absolute().inset_0().into_any_element(),
            None => div().absolute().inset_0().flex().items_center().justify_center()
                .text_color(rgb(MUTED)).child("(no preview)").into_any_element(),
        };

        let entity = cx.entity();
        let inspector = div()
            .w(px(300.0)).h_full()
            .bg(rgb(PANEL)).border_l_1().border_color(rgb(BORDER))
            .p_4().flex().flex_col().gap_4()
            .child(div().text_color(rgb(TEXT)).child(title))
            .child(slider(SliderField::Exposure,    "Exposure",    self.edits.exposure,    -3.0, 3.0, entity.clone()))
            .child(slider(SliderField::Contrast,    "Contrast",    self.edits.contrast,    -1.0, 1.0, entity.clone()))
            .child(slider(SliderField::Saturation,  "Saturation",  self.edits.saturation,  -1.0, 1.0, entity.clone()))
            .child(slider(SliderField::Vibrancy,    "Vibrancy",    self.edits.vibrancy,    -1.0, 1.0, entity.clone()))
            .child(slider(SliderField::Temperature, "Temperature", self.edits.temperature, -1.0, 1.0, entity.clone()))
            .child(div().mt_2().child(
                secondary_button("Reset", cx.listener(|this, _: &ClickEvent, _, cx| this.reset(cx)))
            ));

        div().flex().flex_row().size_full()
            .child(
                div().relative().flex_1().h_full().overflow_hidden().bg(rgb(0x0a0a0a))
                    .child(preview_inner)
            )
            .child(inspector)
    }
}

// ── Root ─────────────────────────────────────────────────────────────────────

impl gpui::Render for Shade {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Evict replaced images from the sprite atlas before drawing the new frame.
        for old in self.pending_drops.drain(..) {
            let _ = window.drop_image(old);
        }

        let body = match self.view {
            View::Library => self.render_library(cx).into_any_element(),
            View::Editor  => self.render_editor(cx).into_any_element(),
        };
        let mut root = div()
            .size_full().flex().flex_col()
            .bg(rgb(BG)).text_color(rgb(TEXT))
            .child(header(self.view, self.selected.is_some(), cx))
            .child(div().flex_1().overflow_hidden().child(body));

        if let Some(status) = self.status.clone() {
            root = root.child(
                div().px_4().py_2().bg(rgb(PANEL)).border_t_1().border_color(rgb(BORDER))
                    .text_color(rgb(MUTED)).child(status),
            );
        }
        root
    }
}

fn main() {
    env_logger::init();
    let worker = RenderWorker::new();

    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1240.0), px(820.0)), cx);
        let worker = worker.clone();
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Shade".into()),
                    appears_transparent: false,
                    traffic_light_position: None,
                }),
                ..Default::default()
            },
            move |_window, cx| cx.new(|_cx| Shade::new(worker.clone())),
        )
        .unwrap();
        cx.activate(true);
    });
}
