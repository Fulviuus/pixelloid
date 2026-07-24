use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{
    codecs::png::PngDecoder, imageops::FilterType, DynamicImage, GenericImageView, ImageDecoder,
    ImageFormat,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    env,
    ffi::{OsStr, OsString},
    fs,
    hash::{Hash, Hasher},
    io::{self, Cursor, Read},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::State;
use tempfile::TempDir;

const MFLUX_VERSION: &str = "0.18.0";
const MFLUX_COMMAND: &str = "mflux-generate-flux2-edit";
const MODEL_NAME: &str = "flux2-klein-4b";
const MODEL_CACHE_NAME: &str = "models--black-forest-labs--FLUX.2-klein-4B";
const PIXEL_ART_ADAPTER_REPO: &str = "Limbicnation/pixel-art-lora";
const PIXEL_ART_ADAPTER_CACHE_NAME: &str = "models--Limbicnation--pixel-art-lora";
const PIXEL_ART_ADAPTER_FILE: &str = "pytorch_lora_weights.safetensors";
const PIXEL_ART_ADAPTER_SCALE: &str = "0.35";
// The published adapter is about 325 MB. Reject tiny placeholders, stale Xet
// pointer files, and interrupted downloads before handing a path to MFLUX.
const PIXEL_ART_ADAPTER_MIN_BYTES: u64 = 250 * 1024 * 1024;
const MAX_ENCODED_IMAGE_BYTES: usize = 48 * 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 4_000;
const MAX_PROCESS_LOG_BYTES: usize = 64 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(45 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Default)]
pub struct MagicFixState {
    active_job: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

impl MagicFixState {
    fn register(&self, job_id: &str) -> Result<Arc<AtomicBool>, MagicFixError> {
        let mut active_job = self.active_job.lock().map_err(|_| {
            MagicFixError::new("state_unavailable", "Magic Fix state is unavailable.")
        })?;
        if active_job.is_some() {
            return Err(MagicFixError::new(
                "busy",
                "Another Magic Fix job is already running.",
            ));
        }

        let cancellation = Arc::new(AtomicBool::new(false));
        *active_job = Some((job_id.to_owned(), Arc::clone(&cancellation)));
        Ok(cancellation)
    }

    fn unregister(&self, job_id: &str) {
        if let Ok(mut active_job) = self.active_job.lock() {
            if active_job
                .as_ref()
                .is_some_and(|(active_id, _)| active_id == job_id)
            {
                *active_job = None;
            }
        }
    }

    fn cancel(&self, job_id: &str) -> bool {
        let Ok(active_job) = self.active_job.lock() else {
            return false;
        };
        let Some((active_id, cancellation)) = active_job.as_ref() else {
            return false;
        };
        if active_id != job_id {
            return false;
        }
        cancellation.store(true, Ordering::Release);
        true
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicFixRunRequest {
    pub job_id: String,
    pub current_png_base64: String,
    pub original_png_base64: String,
    pub width: u32,
    pub height: u32,
    pub prompt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicFixRunResponse {
    pub output_png_base64: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicFixCancelRequest {
    pub job_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicFixStatus {
    pub available: bool,
    pub platform_supported: bool,
    pub uv_path: Option<String>,
    pub model_cached: bool,
    pub pixel_art_adapter_cached: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicFixDiagnostics {
    pub platform_supported: bool,
    pub operating_system: String,
    pub architecture: String,
    pub hardware_model: Option<String>,
    pub total_memory_bytes: Option<u64>,
    pub python: ToolDiagnostic,
    pub uv: ToolDiagnostic,
    pub mflux: ToolDiagnostic,
    pub model_cached: bool,
    pub model_cache_path: Option<String>,
    pub pixel_art_adapter_cached: bool,
    pub pixel_art_adapter_path: Option<String>,
    pub setup_state: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDiagnostic {
    pub available: bool,
    pub healthy: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicFixError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl MagicFixError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    fn with_details(mut self, details: impl Into<String>) -> Self {
        let details = details.into();
        if !details.trim().is_empty() {
            self.details = Some(details);
        }
        self
    }
}

#[derive(Debug)]
struct PreparedMagicFixRequest {
    current_path: PathBuf,
    original_path: PathBuf,
    prompt_path: PathBuf,
    output_path: PathBuf,
    width: u32,
    height: u32,
    seed: u32,
}

#[derive(Debug, Clone)]
enum MfluxRuntime {
    Direct(PathBuf),
    Uvx { path: PathBuf, package_cached: bool },
}

impl MfluxRuntime {
    fn command(&self) -> Command {
        match self {
            Self::Direct(path) => Command::new(path),
            Self::Uvx {
                path,
                package_cached,
            } => {
                let mut command = Command::new(path);
                command.args(["tool", "run"]);
                if *package_cached {
                    command.arg("--offline");
                }
                command.args(["--from", "mflux==0.18.0", MFLUX_COMMAND]);
                command
            }
        }
    }

    fn display_path(&self) -> String {
        match self {
            Self::Direct(path) => path.display().to_string(),
            Self::Uvx {
                path,
                package_cached,
            } => format!(
                "{} (uvx, {})",
                path.display(),
                if *package_cached {
                    "cached"
                } else {
                    "first-run setup"
                }
            ),
        }
    }
}

#[derive(Debug)]
struct ProcessResult {
    status: ExitStatus,
    stdout: String,
    stderr: String,
    timed_out: bool,
    cancelled: bool,
}

#[tauri::command]
pub async fn magic_fix_status() -> MagicFixStatus {
    let diagnostics = tauri::async_runtime::spawn_blocking(collect_diagnostics)
        .await
        .unwrap_or_else(|_| diagnostic_failure());

    MagicFixStatus {
        available: diagnostics.platform_supported
            && (diagnostics.mflux.healthy || diagnostics.uv.healthy),
        platform_supported: diagnostics.platform_supported,
        uv_path: diagnostics.uv.path,
        model_cached: diagnostics.model_cached,
        pixel_art_adapter_cached: diagnostics.pixel_art_adapter_cached,
        message: diagnostics.message,
    }
}

#[tauri::command]
pub async fn magic_fix_diagnostics() -> MagicFixDiagnostics {
    tauri::async_runtime::spawn_blocking(collect_diagnostics)
        .await
        .unwrap_or_else(|_| diagnostic_failure())
}

#[tauri::command]
pub async fn magic_fix_run(
    request: MagicFixRunRequest,
    state: State<'_, MagicFixState>,
) -> Result<MagicFixRunResponse, MagicFixError> {
    validate_job_id(&request.job_id)?;
    let job_id = request.job_id.clone();
    let cancellation = state.register(&job_id)?;

    let result =
        tauri::async_runtime::spawn_blocking(move || run_magic_fix_blocking(request, cancellation))
            .await
            .map_err(|error| {
                MagicFixError::new(
                    "worker_failed",
                    "The local Magic Fix worker stopped unexpectedly.",
                )
                .with_details(error.to_string())
            })
            .and_then(|result| result);

    state.unregister(&job_id);
    result
}

#[tauri::command]
pub fn magic_fix_cancel(request: MagicFixCancelRequest, state: State<'_, MagicFixState>) -> bool {
    state.cancel(&request.job_id)
}

fn run_magic_fix_blocking(
    request: MagicFixRunRequest,
    cancellation: Arc<AtomicBool>,
) -> Result<MagicFixRunResponse, MagicFixError> {
    validate_run_request(&request)?;
    if cancellation.load(Ordering::Acquire) {
        return Err(MagicFixError::new("cancelled", "Magic Fix was cancelled."));
    }

    let started = Instant::now();
    let mut runtime = resolve_mflux_runtime().ok_or_else(|| {
        MagicFixError::new(
            "mflux_missing",
            "MFLUX 0.18.0 is not installed. Install it with `uv tool install --upgrade 'mflux==0.18.0'`.",
        )
    })?;
    ensure_runtime_cached(&mut runtime, &cancellation)?;
    ensure_model_available(&cancellation)?;
    let pixel_art_adapter_path = ensure_pixel_art_adapter_available(&cancellation)?;

    // Network-enabled setup is deliberately complete before image paths exist.
    // From this point onward, the generation process is forced offline.
    let workspace = tempfile::Builder::new()
        .prefix("pixelloid-magic-fix-")
        .tempdir()
        .map_err(|error| {
            MagicFixError::new(
                "temporary_storage_failed",
                "Could not create private temporary storage for Magic Fix.",
            )
            .with_details(error.to_string())
        })?;

    let prepared = prepare_images_and_prompt(&workspace, &request)?;
    let process = run_mflux_process(&runtime, &prepared, &pixel_art_adapter_path, &cancellation)?;

    if process.cancelled {
        return Err(MagicFixError::new("cancelled", "Magic Fix was cancelled."));
    }
    if process.timed_out {
        return Err(MagicFixError::new(
            "timeout",
            "Magic Fix exceeded its 45-minute local processing limit.",
        ));
    }
    if !process.status.success() {
        return Err(MagicFixError::new(
            "generation_failed",
            "FLUX.2 Klein could not generate an edit.",
        )
        .with_details(process_failure_details(&process)));
    }

    let output = fs::read(&prepared.output_path).map_err(|error| {
        MagicFixError::new(
            "output_missing",
            "FLUX.2 Klein finished without creating the expected output.",
        )
        .with_details(format!("{}\n{}", error, process_failure_details(&process)))
    })?;
    validate_output_png(&output, request.width, request.height)?;

    Ok(MagicFixRunResponse {
        output_png_base64: BASE64.encode(output),
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

fn validate_run_request(request: &MagicFixRunRequest) -> Result<(), MagicFixError> {
    validate_job_id(&request.job_id)?;

    if request.prompt.trim().is_empty() {
        return Err(MagicFixError::new(
            "invalid_prompt",
            "Magic Fix needs a non-empty prompt.",
        ));
    }
    if request.prompt.chars().count() > MAX_PROMPT_CHARS || request.prompt.contains('\0') {
        return Err(MagicFixError::new(
            "invalid_prompt",
            "The Magic Fix prompt is too long or contains an invalid character.",
        ));
    }
    validate_dimensions(request.width, request.height)?;

    Ok(())
}

fn validate_job_id(job_id: &str) -> Result<(), MagicFixError> {
    let valid = !job_id.is_empty()
        && job_id.len() <= 64
        && job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(MagicFixError::new(
            "invalid_job_id",
            "The Magic Fix job ID must contain only letters, numbers, hyphens, or underscores.",
        ))
    }
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), MagicFixError> {
    let dimensions_valid = (64..=2048).contains(&width)
        && (64..=2048).contains(&height)
        && width.is_multiple_of(16)
        && height.is_multiple_of(16)
        && u64::from(width) * u64::from(height) <= 4_194_304;
    if dimensions_valid {
        Ok(())
    } else {
        Err(MagicFixError::new(
            "invalid_dimensions",
            "Magic Fix dimensions must be multiples of 16, between 64 and 2048 pixels, and no larger than 4 megapixels.",
        ))
    }
}

fn fresh_seed(job_id: &str) -> u32 {
    let mut hasher = DefaultHasher::new();
    job_id.hash(&mut hasher);
    (hasher.finish() % 1_000_000_000) as u32
}

fn prepare_images_and_prompt(
    workspace: &TempDir,
    request: &MagicFixRunRequest,
) -> Result<PreparedMagicFixRequest, MagicFixError> {
    let current = decode_png("current image", &request.current_png_base64)?;
    let original = decode_png("original image", &request.original_png_base64)?;

    let current = if current.dimensions() == (request.width, request.height) {
        current
    } else {
        current.resize_exact(request.width, request.height, FilterType::Nearest)
    };
    let original = if original.dimensions() == (request.width, request.height) {
        original
    } else {
        original.resize_exact(request.width, request.height, FilterType::Lanczos3)
    };

    let current_path = workspace.path().join("current.png");
    let original_path = workspace.path().join("original.png");
    let prompt_path = workspace.path().join("prompt.txt");
    let output_path = workspace.path().join("result.png");

    current
        .to_rgb8()
        .save_with_format(&current_path, ImageFormat::Png)
        .map_err(|error| image_prepare_error("current image", error))?;
    original
        .to_rgb8()
        .save_with_format(&original_path, ImageFormat::Png)
        .map_err(|error| image_prepare_error("original image", error))?;
    fs::write(&prompt_path, request.prompt.as_bytes()).map_err(|error| {
        MagicFixError::new(
            "prompt_write_failed",
            "Could not prepare the local Magic Fix prompt.",
        )
        .with_details(error.to_string())
    })?;

    Ok(PreparedMagicFixRequest {
        current_path,
        original_path,
        prompt_path,
        output_path,
        width: request.width,
        height: request.height,
        seed: fresh_seed(&request.job_id),
    })
}

fn decode_png(label: &str, encoded: &str) -> Result<image::DynamicImage, MagicFixError> {
    if encoded.len() > MAX_ENCODED_IMAGE_BYTES * 4 / 3 + 8 {
        return Err(MagicFixError::new(
            "image_too_large",
            format!("The {label} is too large for Magic Fix."),
        ));
    }

    let encoded = encoded
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(encoded);
    let bytes = BASE64.decode(encoded).map_err(|error| {
        MagicFixError::new(
            "invalid_image",
            format!("The {label} is not valid base64-encoded PNG data."),
        )
        .with_details(error.to_string())
    })?;
    if bytes.len() > MAX_ENCODED_IMAGE_BYTES {
        return Err(MagicFixError::new(
            "image_too_large",
            format!("The {label} is too large for Magic Fix."),
        ));
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(MagicFixError::new(
            "invalid_image",
            format!("The {label} is not a PNG."),
        ));
    }

    let decoder = PngDecoder::new(Cursor::new(bytes)).map_err(|error| {
        MagicFixError::new(
            "invalid_image",
            format!("The {label} could not be decoded."),
        )
        .with_details(error.to_string())
    })?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 8_192
        || height > 8_192
        || u64::from(width) * u64::from(height) > 32_000_000
    {
        return Err(MagicFixError::new(
            "image_too_large",
            format!("The {label} has unsupported dimensions."),
        ));
    }

    DynamicImage::from_decoder(decoder).map_err(|error| {
        MagicFixError::new(
            "invalid_image",
            format!("The {label} could not be decoded."),
        )
        .with_details(error.to_string())
    })
}

fn image_prepare_error(label: &str, error: image::ImageError) -> MagicFixError {
    MagicFixError::new(
        "image_prepare_failed",
        format!("Could not prepare the {label} for local inference."),
    )
    .with_details(error.to_string())
}

fn validate_output_png(bytes: &[u8], width: u32, height: u32) -> Result<(), MagicFixError> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(MagicFixError::new(
            "invalid_output",
            "FLUX.2 Klein returned an invalid PNG.",
        ));
    }
    let output = image::load_from_memory_with_format(bytes, ImageFormat::Png).map_err(|error| {
        MagicFixError::new("invalid_output", "FLUX.2 Klein returned an unreadable PNG.")
            .with_details(error.to_string())
    })?;
    if output.dimensions() != (width, height) {
        return Err(MagicFixError::new(
            "invalid_output_dimensions",
            "FLUX.2 Klein returned an image with unexpected dimensions.",
        )
        .with_details(format!(
            "Expected {width}x{height}, received {}x{}.",
            output.width(),
            output.height()
        )));
    }
    Ok(())
}

fn ensure_runtime_cached(
    runtime: &mut MfluxRuntime,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), MagicFixError> {
    let MfluxRuntime::Uvx {
        path,
        package_cached,
    } = runtime
    else {
        return Ok(());
    };
    if *package_cached {
        return Ok(());
    }

    let mut command = Command::new(path);
    command.args([
        "tool",
        "run",
        "--from",
        "mflux==0.18.0",
        MFLUX_COMMAND,
        "--help",
    ]);
    configure_model_process(&mut command, false);
    let process = run_process(command, RUN_TIMEOUT, Some(cancellation)).map_err(|error| {
        MagicFixError::new(
            "runtime_setup_failed",
            "Could not install the pinned local MFLUX runtime.",
        )
        .with_details(error.to_string())
    })?;
    check_setup_process(
        process,
        "runtime_setup_failed",
        "Could not install the pinned local MFLUX runtime.",
    )?;
    *package_cached = true;
    Ok(())
}

fn ensure_model_available(cancellation: &Arc<AtomicBool>) -> Result<PathBuf, MagicFixError> {
    if let Some(path) = find_model_cache() {
        return Ok(path);
    }

    let uv_path = find_executable("uv", None).ok_or_else(|| {
        MagicFixError::new(
            "uv_missing",
            "uv is required for the one-time FLUX.2 Klein model download.",
        )
    })?;
    let mut command = Command::new(uv_path);
    command.args([
        "tool",
        "run",
        "--from",
        "huggingface-hub>=1.1.6,<2.0",
        "hf",
        "download",
        "black-forest-labs/FLUX.2-klein-4B",
        "--include",
        "vae/*",
        "--include",
        "transformer/*",
        "--include",
        "text_encoder/*",
        "--include",
        "tokenizer/**",
        "--include",
        "added_tokens.json",
        "--include",
        "chat_template.jinja",
    ]);
    configure_model_process(&mut command, false);
    let process = run_process(command, RUN_TIMEOUT, Some(cancellation)).map_err(|error| {
        MagicFixError::new(
            "model_download_failed",
            "Could not download FLUX.2 Klein into the local model cache.",
        )
        .with_details(error.to_string())
    })?;
    check_setup_process(
        process,
        "model_download_failed",
        "Could not download FLUX.2 Klein into the local model cache.",
    )?;

    find_model_cache().ok_or_else(|| {
        MagicFixError::new(
            "model_incomplete",
            "The FLUX.2 Klein download finished, but the local model cache is incomplete.",
        )
    })
}

fn ensure_pixel_art_adapter_available(
    cancellation: &Arc<AtomicBool>,
) -> Result<PathBuf, MagicFixError> {
    if let Some(path) = find_pixel_art_adapter_cache() {
        return Ok(path);
    }

    let uv_path = find_executable("uv", None).ok_or_else(|| {
        MagicFixError::new(
            "uv_missing",
            "uv is required for the one-time pixel-art adapter download.",
        )
    })?;
    let mut command = Command::new(uv_path);
    command.args([
        "tool",
        "run",
        "--from",
        "huggingface-hub>=1.1.6,<2.0",
        "hf",
        "download",
        PIXEL_ART_ADAPTER_REPO,
        PIXEL_ART_ADAPTER_FILE,
        "--force-download",
    ]);
    configure_model_process(&mut command, false);
    let process = run_process(command, RUN_TIMEOUT, Some(cancellation)).map_err(|error| {
        MagicFixError::new(
            "adapter_download_failed",
            "Could not download the pixel-art adapter into the local model cache.",
        )
        .with_details(error.to_string())
    })?;
    check_setup_process(
        process,
        "adapter_download_failed",
        "Could not download the pixel-art adapter into the local model cache.",
    )?;

    find_pixel_art_adapter_cache().ok_or_else(|| {
        MagicFixError::new(
            "adapter_incomplete",
            "The pixel-art adapter download finished, but its local cache file is incomplete.",
        )
    })
}

fn check_setup_process(
    process: ProcessResult,
    failure_code: &str,
    failure_message: &str,
) -> Result<(), MagicFixError> {
    if process.cancelled {
        return Err(MagicFixError::new("cancelled", "Magic Fix was cancelled."));
    }
    if process.timed_out {
        return Err(MagicFixError::new(
            "timeout",
            "Magic Fix setup exceeded its 45-minute processing limit.",
        ));
    }
    if !process.status.success() {
        return Err(MagicFixError::new(failure_code, failure_message)
            .with_details(process_failure_details(&process)));
    }
    Ok(())
}

fn run_mflux_process(
    runtime: &MfluxRuntime,
    request: &PreparedMagicFixRequest,
    pixel_art_adapter_path: &Path,
    cancellation: &Arc<AtomicBool>,
) -> Result<ProcessResult, MagicFixError> {
    let mut command = runtime.command();
    command
        .arg("--model")
        .arg(MODEL_NAME)
        .arg("--image-paths")
        .arg(&request.current_path)
        .arg(&request.original_path)
        .arg("--prompt-file")
        .arg(&request.prompt_path)
        .arg("--steps")
        .arg("4")
        .arg("--guidance")
        .arg("1.0")
        .arg("--seed")
        .arg(request.seed.to_string())
        .arg("--width")
        .arg(request.width.to_string())
        .arg("--height")
        .arg(request.height.to_string())
        .arg("--quantize")
        .arg("8")
        .arg("--lora-paths")
        .arg(pixel_art_adapter_path)
        .arg("--lora-scales")
        // Text-to-image examples use a stronger adapter, but a conservative
        // edit strength preserves the user's palette, pose, and geometry.
        .arg(PIXEL_ART_ADAPTER_SCALE)
        .arg("--output")
        .arg(&request.output_path);
    configure_model_process(&mut command, true);

    run_process(command, RUN_TIMEOUT, Some(cancellation)).map_err(|error| {
        MagicFixError::new(
            "process_failed",
            "Could not start the local FLUX.2 Klein runtime.",
        )
        .with_details(format!("Runtime: {}\n{error}", runtime.display_path()))
    })
}

fn configure_model_process(command: &mut Command, offline: bool) {
    command
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("DO_NOT_TRACK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(hf_home) = env::var_os("PIXELLOID_HF_HOME") {
        command.env("HF_HOME", hf_home);
    }
    if offline {
        command
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HF_DATASETS_OFFLINE", "1")
            .env("HF_HUB_ENABLE_HF_TRANSFER", "0")
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("ALL_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .env_remove("all_proxy");
    } else {
        // The only network activity permitted by this bridge is MFLUX's
        // one-time model-weight download into the user's Hugging Face cache.
        command
            .env_remove("HF_HUB_OFFLINE")
            .env_remove("TRANSFORMERS_OFFLINE")
            .env_remove("HF_DATASETS_OFFLINE");
    }
}

fn run_process(
    mut command: Command,
    timeout: Duration,
    cancellation: Option<&Arc<AtomicBool>>,
) -> io::Result<ProcessResult> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let stdout_reader = child.stdout.take().map(spawn_log_reader);
    let stderr_reader = child.stderr.take().map(spawn_log_reader);
    let started = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;

    let status = loop {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            cancelled = true;
            break terminate_child(&mut child)?;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            break terminate_child(&mut child)?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(Duration::from_millis(100));
    };

    let stdout = join_log_reader(stdout_reader);
    let stderr = join_log_reader(stderr_reader);
    Ok(ProcessResult {
        status,
        stdout,
        stderr,
        timed_out,
        cancelled,
    })
}

fn terminate_child(child: &mut Child) -> io::Result<ExitStatus> {
    #[cfg(unix)]
    {
        let process_group = -(child.id() as i32);
        // SAFETY: `process_group` identifies the isolated process group created
        // immediately before spawn. Signals carry no pointers or shared memory.
        unsafe {
            libc::kill(process_group, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(50));
        }
        // SAFETY: same isolated process-group invariant as above.
        unsafe {
            libc::kill(process_group, libc::SIGKILL);
        }
    }

    let _ = child.kill();
    child.wait()
}

fn spawn_log_reader<R>(mut reader: R) -> thread::JoinHandle<String>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut retained = Vec::new();
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if retained.len() < MAX_PROCESS_LOG_BYTES {
                        let remaining = MAX_PROCESS_LOG_BYTES - retained.len();
                        retained.extend_from_slice(&buffer[..count.min(remaining)]);
                    }
                }
            }
        }
        String::from_utf8_lossy(&retained).into_owned()
    })
}

fn join_log_reader(reader: Option<thread::JoinHandle<String>>) -> String {
    reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default()
}

fn process_failure_details(process: &ProcessResult) -> String {
    let mut details = String::new();
    if !process.stderr.trim().is_empty() {
        details.push_str(process.stderr.trim());
    }
    if !process.stdout.trim().is_empty() {
        if !details.is_empty() {
            details.push('\n');
        }
        details.push_str(process.stdout.trim());
    }
    details
}

fn collect_diagnostics() -> MagicFixDiagnostics {
    let platform_supported = cfg!(all(target_os = "macos", target_arch = "aarch64"));
    let uv_path = find_executable("uv", None);
    let uv = probe_simple_tool(uv_path.clone(), &["--version"]);

    let direct_mflux_path = find_mflux_executable(uv_path.as_deref());
    let (runtime, mflux) = if let Some(path) = direct_mflux_path {
        let version = read_console_script_package_version(&path);
        let probe = probe_command(&path, &["--help"], version);
        (Some(MfluxRuntime::Direct(path)), probe)
    } else if let Some(path) = uv_path {
        let mut command = Command::new(&path);
        command.args([
            "tool",
            "run",
            "--offline",
            "--from",
            "mflux==0.18.0",
            MFLUX_COMMAND,
            "--help",
        ]);
        configure_model_process(&mut command, true);
        match run_process(command, PROBE_TIMEOUT, None) {
            Ok(result) if result.status.success() => (
                Some(MfluxRuntime::Uvx {
                    path: path.clone(),
                    package_cached: true,
                }),
                ToolDiagnostic {
                    available: true,
                    healthy: true,
                    path: Some(format!("{} (uvx, offline)", path.display())),
                    version: Some(MFLUX_VERSION.to_owned()),
                    message: "Pinned MFLUX runtime is available through the local uv cache."
                        .to_owned(),
                },
            ),
            _ => (
                None,
                ToolDiagnostic {
                    available: false,
                    healthy: false,
                    path: None,
                    version: None,
                    message: "MFLUX is not installed in the local uv tool cache.".to_owned(),
                },
            ),
        }
    } else {
        (
            None,
            ToolDiagnostic {
                available: false,
                healthy: false,
                path: None,
                version: None,
                message: "MFLUX is not installed.".to_owned(),
            },
        )
    };

    let python_path = find_python_executable(runtime.as_ref());
    let python = probe_simple_tool(python_path, &["--version"]);
    let model_cache_path = find_model_cache();
    let model_cached = model_cache_path.is_some();
    let pixel_art_adapter_path = find_pixel_art_adapter_cache();
    let pixel_art_adapter_cached = pixel_art_adapter_path.is_some();

    let (setup_state, message) = if !platform_supported {
        (
            "unsupportedPlatform",
            "Local Magic Fix currently requires an Apple Silicon Mac.".to_owned(),
        )
    } else if !mflux.healthy && !uv.healthy {
        (
            "mfluxMissing",
            "Install uv to enable the local FLUX.2 Klein runtime.".to_owned(),
        )
    } else if !mflux.healthy {
        (
            "runtimeSetupRequired",
            "The pinned MFLUX runtime, FLUX.2 Klein model, and Limbicnation pixel-art adapter will be installed on first run. Images remain on this Mac."
                .to_owned(),
        )
    } else if !model_cached && !pixel_art_adapter_cached {
        (
            "modelDownloadRequired",
            "FLUX.2 Klein 4B and the Limbicnation pixel-art adapter need a one-time download. Images remain on this Mac."
                .to_owned(),
        )
    } else if !model_cached {
        (
            "modelDownloadRequired",
            "FLUX.2 Klein 4B needs a one-time model download. Images remain on this Mac."
                .to_owned(),
        )
    } else if !pixel_art_adapter_cached {
        (
            "pixelArtAdapterDownloadRequired",
            "The Limbicnation pixel-art adapter needs a one-time download. Images remain on this Mac."
                .to_owned(),
        )
    } else {
        (
            "ready",
            "FLUX.2 Klein and the Limbicnation pixel-art adapter are ready for fully local Magic Fix."
                .to_owned(),
        )
    };

    MagicFixDiagnostics {
        platform_supported,
        operating_system: env::consts::OS.to_owned(),
        architecture: env::consts::ARCH.to_owned(),
        hardware_model: sysctl_value("hw.model"),
        total_memory_bytes: sysctl_value("hw.memsize").and_then(|value| value.parse().ok()),
        python,
        uv,
        mflux,
        model_cached,
        model_cache_path: model_cache_path.map(|path| path.display().to_string()),
        pixel_art_adapter_cached,
        pixel_art_adapter_path: pixel_art_adapter_path.map(|path| path.display().to_string()),
        setup_state: setup_state.to_owned(),
        message,
    }
}

fn diagnostic_failure() -> MagicFixDiagnostics {
    let unavailable = |message: &str| ToolDiagnostic {
        available: false,
        healthy: false,
        path: None,
        version: None,
        message: message.to_owned(),
    };
    MagicFixDiagnostics {
        platform_supported: cfg!(all(target_os = "macos", target_arch = "aarch64")),
        operating_system: env::consts::OS.to_owned(),
        architecture: env::consts::ARCH.to_owned(),
        hardware_model: None,
        total_memory_bytes: None,
        python: unavailable("Python diagnostics failed."),
        uv: unavailable("uv diagnostics failed."),
        mflux: unavailable("MFLUX diagnostics failed."),
        model_cached: false,
        model_cache_path: None,
        pixel_art_adapter_cached: false,
        pixel_art_adapter_path: None,
        setup_state: "diagnosticsFailed".to_owned(),
        message: "Could not inspect the local Magic Fix runtime.".to_owned(),
    }
}

fn resolve_mflux_runtime() -> Option<MfluxRuntime> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return None;
    }

    let uv_path = find_executable("uv", None);
    if let Some(path) = find_mflux_executable(uv_path.as_deref()) {
        return Some(MfluxRuntime::Direct(path));
    }

    uv_path.map(|path| {
        let package_cached = uvx_package_cached(&path);
        MfluxRuntime::Uvx {
            path,
            package_cached,
        }
    })
}

fn find_mflux_executable(uv_path: Option<&Path>) -> Option<PathBuf> {
    if let Ok(override_path) = env::var("PIXELLOID_MFLUX_BIN") {
        let path = PathBuf::from(override_path);
        if path.is_absolute() && is_executable(&path) {
            if let Some(path) = supported_mflux_executable(path) {
                return Some(path);
            }
        }
    }

    if let Some(uv_path) = uv_path {
        if let Some(bin_dir) = uv_tool_bin_dir(uv_path) {
            let candidate = bin_dir.join(executable_name(MFLUX_COMMAND));
            if is_executable(&candidate) {
                if let Some(path) = supported_mflux_executable(candidate) {
                    return Some(path);
                }
            }
        }
    }

    find_executable(MFLUX_COMMAND, None).and_then(supported_mflux_executable)
}

fn supported_mflux_executable(path: PathBuf) -> Option<PathBuf> {
    let path = canonical_executable(path)?;
    (read_console_script_package_version(&path).as_deref() == Some(MFLUX_VERSION)).then_some(path)
}

fn find_python_executable(runtime: Option<&MfluxRuntime>) -> Option<PathBuf> {
    if let Some(MfluxRuntime::Direct(mflux_path)) = runtime {
        if let Some(interpreter) = console_script_interpreter(mflux_path) {
            if is_executable(&interpreter) {
                return canonical_executable(interpreter);
            }
        }
    }
    find_executable("python3", None)
}

fn uvx_package_cached(uv_path: &Path) -> bool {
    let mut command = Command::new(uv_path);
    command.args([
        "tool",
        "run",
        "--offline",
        "--from",
        "mflux==0.18.0",
        MFLUX_COMMAND,
        "--help",
    ]);
    configure_model_process(&mut command, true);
    run_process(command, PROBE_TIMEOUT, None)
        .is_ok_and(|result| result.status.success() && !result.timed_out)
}

fn uv_tool_bin_dir(uv_path: &Path) -> Option<PathBuf> {
    let mut command = Command::new(uv_path);
    command.args(["tool", "dir", "--bin"]);
    configure_model_process(&mut command, true);
    let result = run_process(command, Duration::from_secs(3), None).ok()?;
    if !result.status.success() {
        return None;
    }
    let path = PathBuf::from(result.stdout.trim());
    path.is_absolute().then_some(path)
}

fn read_console_script_package_version(path: &Path) -> Option<String> {
    let interpreter = console_script_interpreter(path)?;
    let mut command = Command::new(interpreter);
    command.args([
        "-c",
        "import importlib.metadata; print(importlib.metadata.version('mflux'))",
    ]);
    configure_model_process(&mut command, true);
    let result = run_process(command, Duration::from_secs(3), None).ok()?;
    result
        .status
        .success()
        .then(|| result.stdout.trim().to_owned())
        .filter(|version| !version.is_empty())
}

fn console_script_interpreter(path: &Path) -> Option<PathBuf> {
    let contents = fs::read(path).ok()?;
    let first_line = contents.split(|byte| *byte == b'\n').next()?;
    let shebang = first_line.strip_prefix(b"#!")?;
    let interpreter = String::from_utf8_lossy(shebang).trim().to_owned();
    (!interpreter.is_empty()).then(|| PathBuf::from(interpreter))
}

fn probe_simple_tool(path: Option<PathBuf>, args: &[&str]) -> ToolDiagnostic {
    let Some(path) = path else {
        return ToolDiagnostic {
            available: false,
            healthy: false,
            path: None,
            version: None,
            message: "Not found.".to_owned(),
        };
    };
    probe_command(&path, args, None)
}

fn probe_command(path: &Path, args: &[&str], known_version: Option<String>) -> ToolDiagnostic {
    let mut command = Command::new(path);
    command.args(args);
    configure_model_process(&mut command, true);
    match run_process(command, PROBE_TIMEOUT, None) {
        Ok(result) => {
            let output = if result.stdout.trim().is_empty() {
                result.stderr.trim()
            } else {
                result.stdout.trim()
            };
            ToolDiagnostic {
                available: true,
                healthy: result.status.success() && !result.timed_out,
                path: Some(path.display().to_string()),
                version: known_version.or_else(|| first_version_token(output)),
                message: if result.status.success() {
                    "Available.".to_owned()
                } else {
                    "Found, but its health check failed.".to_owned()
                },
            }
        }
        Err(error) => ToolDiagnostic {
            available: true,
            healthy: false,
            path: Some(path.display().to_string()),
            version: known_version,
            message: format!("Found, but could not be started: {error}"),
        },
    }
}

fn first_version_token(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|token| {
            token
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
                && token.contains('.')
        })
        .map(|token| {
            token
                .trim_matches(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '.'
                })
                .to_owned()
        })
}

fn find_executable(name: &str, extra_dirs: Option<&[PathBuf]>) -> Option<PathBuf> {
    let executable = executable_name(name);
    let mut directories = Vec::new();
    if let Some(extra_dirs) = extra_dirs {
        directories.extend_from_slice(extra_dirs);
    }
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path));
    }
    if let Some(home) = home_dir() {
        directories.push(home.join(".local/bin"));
        directories.push(home.join(".cargo/bin"));
    }
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);

    directories.into_iter().find_map(|directory| {
        let candidate = directory.join(&executable);
        is_executable(&candidate)
            .then(|| canonical_executable(candidate))
            .flatten()
    })
}

fn executable_name(name: &str) -> OsString {
    #[cfg(windows)]
    {
        OsString::from(format!("{name}.exe"))
    }
    #[cfg(not(windows))]
    {
        OsString::from(name)
    }
}

fn canonical_executable(path: PathBuf) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn find_model_cache() -> Option<PathBuf> {
    let cache_root = hugging_face_hub_cache_root()?;
    let model_path = cache_root.join(MODEL_CACHE_NAME);
    model_cache_looks_complete(&model_path).then_some(model_path)
}

fn find_pixel_art_adapter_cache() -> Option<PathBuf> {
    let cache_root = hugging_face_hub_cache_root()?;
    find_pixel_art_adapter_in_cache_root(&cache_root)
}

fn hugging_face_hub_cache_root() -> Option<PathBuf> {
    resolve_hugging_face_hub_cache_root(
        env::var_os("HF_HUB_CACHE"),
        env::var_os("PIXELLOID_HF_HOME"),
        env::var_os("HF_HOME"),
        home_dir().map(PathBuf::into_os_string),
    )
}

fn resolve_hugging_face_hub_cache_root(
    hub_cache: Option<OsString>,
    pixelloid_hf_home: Option<OsString>,
    hf_home: Option<OsString>,
    home: Option<OsString>,
) -> Option<PathBuf> {
    hub_cache
        .map(PathBuf::from)
        .or_else(|| pixelloid_hf_home.map(|path| PathBuf::from(path).join("hub")))
        .or_else(|| hf_home.map(|path| PathBuf::from(path).join("hub")))
        .or_else(|| home.map(|path| PathBuf::from(path).join(".cache/huggingface/hub")))
}

fn find_pixel_art_adapter_in_cache_root(cache_root: &Path) -> Option<PathBuf> {
    let snapshots = cache_root
        .join(PIXEL_ART_ADAPTER_CACHE_NAME)
        .join("snapshots");
    let revisions = fs::read_dir(snapshots).ok()?;

    revisions
        .flatten()
        .map(|revision| revision.path().join(PIXEL_ART_ADAPTER_FILE))
        .find_map(|candidate| {
            pixel_art_adapter_looks_complete(&candidate)
                .then(|| fs::canonicalize(&candidate).unwrap_or(candidate))
        })
}

fn pixel_art_adapter_looks_complete(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() < PIXEL_ART_ADAPTER_MIN_BYTES {
        return false;
    }

    // Safetensors starts with an unsigned 64-bit little-endian JSON header
    // length. Checking it catches sparse/zero-filled files as well as text
    // pointer files while avoiding a 325 MB read during every status probe.
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut header_length_bytes = [0_u8; 8];
    if file.read_exact(&mut header_length_bytes).is_err() {
        return false;
    }
    let header_length = u64::from_le_bytes(header_length_bytes);
    header_length > 1
        && header_length <= 16 * 1024 * 1024
        && header_length.saturating_add(8) < metadata.len()
}

fn model_cache_looks_complete(path: &Path) -> bool {
    let snapshots = path.join("snapshots");
    let Ok(revisions) = fs::read_dir(snapshots) else {
        return false;
    };

    revisions.flatten().any(|revision| {
        let root = revision.path();
        root.is_dir()
            && has_file_with_extension(&root.join("transformer"), OsStr::new("safetensors"), 2)
            && has_file_with_extension(&root.join("transformer"), OsStr::new("json"), 2)
            && count_files_with_extension(&root.join("text_encoder"), OsStr::new("safetensors"))
                >= 2
            && has_file_with_extension(&root.join("text_encoder"), OsStr::new("json"), 2)
            && has_file_with_extension(&root.join("vae"), OsStr::new("safetensors"), 2)
            && has_file_with_extension(&root.join("vae"), OsStr::new("json"), 2)
            && has_file_named(&root.join("tokenizer"), OsStr::new("tokenizer.json"), 2)
            && has_file_named(
                &root.join("tokenizer"),
                OsStr::new("chat_template.jinja"),
                2,
            )
    })
}

fn count_files_with_extension(path: &Path, extension: &OsStr) -> usize {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let candidate = entry.path();
            fs::metadata(&candidate).is_ok_and(|metadata| metadata.is_file())
                && candidate.extension() == Some(extension)
        })
        .count()
}

fn has_file_with_extension(path: &Path, extension: &OsStr, depth: usize) -> bool {
    has_matching_file(path, depth, &|candidate| {
        candidate.extension() == Some(extension)
    })
}

fn has_file_named(path: &Path, name: &OsStr, depth: usize) -> bool {
    has_matching_file(path, depth, &|candidate| {
        candidate.file_name() == Some(name)
    })
}

fn has_matching_file(path: &Path, depth: usize, predicate: &dyn Fn(&Path) -> bool) -> bool {
    if depth == 0 {
        return false;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let candidate = entry.path();
        match fs::metadata(&candidate) {
            Ok(metadata) if metadata.is_file() => predicate(&candidate),
            Ok(metadata) if metadata.is_dir() => {
                has_matching_file(&candidate, depth - 1, predicate)
            }
            _ => false,
        }
    })
}

fn sysctl_value(name: &str) -> Option<String> {
    let sysctl = ["/usr/sbin/sysctl", "/usr/bin/sysctl"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| is_executable(path))?;
    let mut command = Command::new(sysctl);
    command.args(["-n", name]);
    configure_model_process(&mut command, true);
    let result = run_process(command, Duration::from_secs(2), None).ok()?;
    result
        .status
        .success()
        .then(|| result.stdout.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn request() -> MagicFixRunRequest {
        MagicFixRunRequest {
            job_id: "magic-fix_42".to_owned(),
            current_png_base64: String::new(),
            original_png_base64: String::new(),
            width: 1024,
            height: 512,
            prompt: "Preserve the composition and restore pixel-art detail.".to_owned(),
        }
    }

    #[test]
    fn validates_job_ids() {
        assert!(validate_job_id("job-1_ok").is_ok());
        assert!(validate_job_id("").is_err());
        assert!(validate_job_id("../escape").is_err());
        assert!(validate_job_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn requires_flux_compatible_dimensions() {
        assert!(validate_dimensions(1024, 512).is_ok());
        assert!(validate_dimensions(1023, 512).is_err());
        assert!(validate_dimensions(32, 512).is_err());
        assert!(validate_dimensions(2048, 2048).is_ok());
    }

    #[test]
    fn validates_prompt_before_decoding_images() {
        let mut request = request();
        request.prompt.clear();
        assert_eq!(
            validate_run_request(&request).unwrap_err().code,
            "invalid_prompt"
        );
    }

    #[test]
    fn cancellation_registry_rejects_duplicates_and_cancels() {
        let state = MagicFixState::default();
        let flag = state.register("same-job").unwrap();
        assert!(state.register("same-job").is_err());
        assert!(state.cancel("same-job"));
        assert!(flag.load(Ordering::Acquire));
        state.unregister("same-job");
        assert!(!state.cancel("same-job"));
    }

    #[test]
    fn strips_only_png_data_url_prefix() {
        let bytes = b"\x89PNG\r\n\x1a\nnot-a-real-image";
        let encoded = BASE64.encode(bytes);
        let data_url = format!("data:image/png;base64,{encoded}");
        let decoded = BASE64
            .decode(
                data_url
                    .strip_prefix("data:image/png;base64,")
                    .unwrap_or(&data_url),
            )
            .unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn resolves_hugging_face_cache_overrides_in_order() {
        assert_eq!(
            resolve_hugging_face_hub_cache_root(
                Some(OsString::from("/explicit/hub")),
                Some(OsString::from("/pixelloid")),
                Some(OsString::from("/hugging-face")),
                Some(OsString::from("/home/tester")),
            ),
            Some(PathBuf::from("/explicit/hub"))
        );
        assert_eq!(
            resolve_hugging_face_hub_cache_root(
                None,
                Some(OsString::from("/pixelloid")),
                Some(OsString::from("/hugging-face")),
                Some(OsString::from("/home/tester")),
            ),
            Some(PathBuf::from("/pixelloid/hub"))
        );
        assert_eq!(
            resolve_hugging_face_hub_cache_root(
                None,
                None,
                Some(OsString::from("/hugging-face")),
                Some(OsString::from("/home/tester")),
            ),
            Some(PathBuf::from("/hugging-face/hub"))
        );
        assert_eq!(
            resolve_hugging_face_hub_cache_root(
                None,
                None,
                None,
                Some(OsString::from("/home/tester")),
            ),
            Some(PathBuf::from("/home/tester/.cache/huggingface/hub"))
        );
    }

    #[test]
    fn adapter_cache_requires_the_exact_complete_safetensors_file() {
        let cache = tempfile::tempdir().unwrap();
        let snapshot = cache
            .path()
            .join(PIXEL_ART_ADAPTER_CACHE_NAME)
            .join("snapshots")
            .join("revision");
        fs::create_dir_all(&snapshot).unwrap();

        let wrong_name = snapshot.join("pytorch_lora_weights.comfyui.safetensors");
        write_fake_adapter(&wrong_name, PIXEL_ART_ADAPTER_MIN_BYTES);
        assert!(find_pixel_art_adapter_in_cache_root(cache.path()).is_none());

        let expected = snapshot.join(PIXEL_ART_ADAPTER_FILE);
        write_fake_adapter(&expected, 1024);
        assert!(find_pixel_art_adapter_in_cache_root(cache.path()).is_none());

        write_fake_adapter(&expected, PIXEL_ART_ADAPTER_MIN_BYTES);
        assert_eq!(
            find_pixel_art_adapter_in_cache_root(cache.path()),
            Some(fs::canonicalize(expected).unwrap())
        );
    }

    #[test]
    fn adapter_cache_rejects_a_large_non_safetensors_placeholder() {
        let cache = tempfile::tempdir().unwrap();
        let expected = cache
            .path()
            .join(PIXEL_ART_ADAPTER_CACHE_NAME)
            .join("snapshots")
            .join("revision")
            .join(PIXEL_ART_ADAPTER_FILE);
        fs::create_dir_all(expected.parent().unwrap()).unwrap();
        fs::File::create(&expected)
            .unwrap()
            .set_len(PIXEL_ART_ADAPTER_MIN_BYTES)
            .unwrap();

        assert!(find_pixel_art_adapter_in_cache_root(cache.path()).is_none());
    }

    fn write_fake_adapter(path: &Path, length: u64) {
        let mut file = fs::File::create(path).unwrap();
        file.set_len(length).unwrap();
        file.write_all(&2_u64.to_le_bytes()).unwrap();
        file.write_all(b"{}").unwrap();
    }
}
