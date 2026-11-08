use folio::tts::{extract_engine, finish_wav, validate_text, verify_file, Artifact, TtsManager};
use std::fs;

#[test]
fn corrupt_and_truncated_downloads_are_rejected() {
    let file = std::env::temp_dir().join(format!("folio-tts-integrity-{}", std::process::id()));
    fs::write(&file, b"abc").unwrap();
    let digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert!(verify_file(&file, 3, digest).is_ok());
    assert!(verify_file(&file, 4, digest).is_err());
    assert!(verify_file(&file, 3, &"0".repeat(64)).is_err());
    fs::remove_file(file).unwrap();
}

#[test]
fn speech_rejects_empty_and_oversized_chunks() {
    assert!(validate_text("   ").is_err());
    assert!(validate_text(&"a".repeat(601)).is_err());
    assert!(validate_text("A selected passage.").is_ok());
    assert!(validate_text(&"é".repeat(600)).is_ok());
}

#[test]
fn missing_pack_is_not_installed_and_stop_invalidates_requests() {
    let manager = TtsManager::default();
    let directory = std::env::temp_dir().join("folio-tts-no-such-installation");
    assert!(!manager.status(&directory).installed);
    let generation = manager.begin();
    manager.stop();
    assert!(!manager.is_current(generation));
}

#[test]
fn streaming_wav_headers_are_finalized_and_invalid_audio_is_rejected() {
    let mut wav = vec![0; 48];
    wav[..4].copy_from_slice(b"RIFF");
    wav[8..12].copy_from_slice(b"WAVE");
    wav[12..16].copy_from_slice(b"fmt ");
    wav[16..20].copy_from_slice(&16u32.to_le_bytes());
    wav[36..40].copy_from_slice(b"data");
    wav[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
    finish_wav(&mut wav).unwrap();
    assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 40);
    assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 4);
    assert!(finish_wav(&mut wav[..44]).is_err());
    assert!(finish_wav(&mut [0; 44]).is_err());
}

#[test]
fn extraction_copies_only_the_regular_engine_file() {
    use flate2::{write::GzEncoder, Compression};
    let dir = std::env::temp_dir().join(format!("folio-tts-archive-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let archive = dir.join("test.tar.gz");
    let mut tar = tar::Builder::new(GzEncoder::new(
        fs::File::create(&archive).unwrap(),
        Compression::default(),
    ));
    for (name, bytes) in [
        ("runtime/readme.txt", b"ignored".as_slice()),
        ("runtime/pocket-tts", b"engine".as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, name, bytes).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap();
    extract_engine(&archive, &dir.join("engine"), false).unwrap();
    assert_eq!(fs::read(dir.join("engine")).unwrap(), b"engine");
    assert!(!dir.join("runtime").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn cancellation_does_not_wait_for_download_body() {
    cancelled_download(true).await;
}

#[tokio::test]
async fn cancellation_does_not_wait_for_response_headers() {
    cancelled_download(false).await;
}

async fn cancelled_download(send_headers: bool) {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request);
        if send_headers {
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\na")
                .unwrap();
        }
        std::thread::sleep(Duration::from_millis(700));
    });
    let manager = Arc::new(TtsManager::default());
    let generation = 0;
    let cancel = manager.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel.cancel_install();
    });
    let file = std::env::temp_dir().join(format!(
        "folio-tts-cancel-{}-{send_headers}",
        std::process::id()
    ));
    let artifact = Artifact {
        name: "fixture".into(),
        url: format!("http://{addr}/"),
        size: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
    };
    let start = Instant::now();
    let error = manager
        .download(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            &artifact,
            &file,
            generation,
        )
        .await
        .unwrap_err();
    assert!(error.contains("cancelled"));
    assert!(start.elapsed() < Duration::from_millis(600));
    assert!(!manager.status(file.parent().unwrap()).installed);
    let _ = fs::remove_file(file);
    server.join().unwrap();
}

#[tokio::test]
async fn stopping_playback_does_not_cancel_a_voice_download() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")
            .unwrap();
    });
    let manager = TtsManager::default();
    manager.begin();
    manager.stop();
    let file = std::env::temp_dir().join(format!(
        "folio-tts-independent-download-{}",
        std::process::id()
    ));
    let artifact = Artifact {
        name: "fixture".into(),
        url: format!("http://{addr}/"),
        size: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
    };
    manager
        .download(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            &artifact,
            &file,
            0,
        )
        .await
        .unwrap();
    assert_eq!(fs::read(&file).unwrap(), b"abc");
    fs::remove_file(file).unwrap();
    server.join().unwrap();
}

#[tokio::test]
#[ignore = "requires the separately downloaded Pocket TTS runtime and voice"]
async fn real_optional_runtime_synthesizes_offline_and_stops() {
    use sha2::{Digest, Sha256};
    let source = std::path::PathBuf::from(
        std::env::var("FOLIO_TTS_SMOKE_DIR")
            .expect("set FOLIO_TTS_SMOKE_DIR to the verified voice fixture"),
    );
    let base = std::env::temp_dir().join(format!("folio-real-speech-{}", std::process::id()));
    let dir = base.join("pocket-v4-alba-1");
    fs::create_dir_all(&dir).unwrap();
    let exe = dir.join(if cfg!(windows) {
        "pocket-tts.exe"
    } else {
        "pocket-tts"
    });
    extract_engine(&source.join("engine.tar.gz"), &exe, false).unwrap();
    for name in ["model.safetensors", "voice.safetensors", "tokenizer.json"] {
        fs::copy(source.join(name), dir.join(name)).unwrap();
    }
    folio::tts::write_config(&dir, &dir).unwrap();
    let engine = fs::read(&exe).unwrap();
    fs::write(dir.join("installation.json"), serde_json::to_vec(&serde_json::json!({"engine_size":engine.len(),"engine_sha256":format!("{:x}",Sha256::digest(&engine))})).unwrap()).unwrap();
    let manager = TtsManager::default();
    assert!(manager.status(&base).installed);
    let generation = manager.begin();
    let audio = manager
        .synthesize(
            &base,
            "Folio reads this passage entirely on your device.",
            generation,
        )
        .await
        .unwrap();
    assert!(audio.len() > 24000);
    assert_eq!(&audio[..4], b"RIFF");
    assert_eq!(
        u32::from_le_bytes(audio[4..8].try_into().unwrap()) as usize,
        audio.len() - 8
    );
    manager.stop();
    assert!(manager
        .synthesize(&base, "This request was cancelled.", generation)
        .await
        .is_err());
    fs::remove_dir_all(base).unwrap();
}
