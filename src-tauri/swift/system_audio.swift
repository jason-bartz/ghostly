import AudioToolbox
import CoreAudio
import Darwin
import Dispatch
import Foundation

// MARK: - System audio capture via CoreAudio process taps
//
// Compiled by build.rs into a static library and linked into the Rust binary.
// See swift/system_audio_bridge.h for the C surface.
//
// Why process taps rather than ScreenCaptureKit: taps need no Screen Recording
// permission, show no purple capture indicator, and let us exclude our own
// process so Ghostly's own audio feedback sounds never bleed into the meeting
// transcript. Requires macOS 14.2+; callers must gate on
// ghostly_system_audio_supported().

private let kGhostlyTapName = "Ghostly Meeting Capture"
private let kGhostlyAggregateName = "Ghostly System Capture"

private func duplicateCString(_ text: String) -> UnsafeMutablePointer<CChar>? {
  return text.withCString { strdup($0) }
}

/// Owns the tap, the aggregate device that clocks it, and the IOProc.
/// All mutation happens under `lock`; the IOProc block itself touches only
/// immutable captured values so the audio thread never contends on it.
private final class SystemAudioCapture: @unchecked Sendable {
  static let shared = SystemAudioCapture()

  private let lock = NSLock()

  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var ioProcID: AudioDeviceIOProcID?
  private var running = false
  private var nativeSampleRate: Double = 0
  private var lastError: String?

  /// Scratch buffer for de-interleaving. Sized on first use and reused, so the
  /// audio thread never allocates. Guarded by the single-IOProc invariant —
  /// CoreAudio serializes IOProc invocations for one device.
  private var monoScratch = [Float](repeating: 0, count: 8192)

  private let ioQueue = DispatchQueue(
    label: "computer.ghostly.system-audio", qos: .userInitiated)

  // MARK: Public surface

  func isRunning() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  func sampleRate() -> Double {
    lock.lock()
    defer { lock.unlock() }
    return running ? nativeSampleRate : 0
  }

  func takeLastError() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return lastError
  }

  private func fail(_ message: String, _ code: Int32) -> Int32 {
    lastError = message
    return code
  }

  @available(macOS 14.2, *)
  func start(callback: @escaping GhostlySystemAudioCallback, userdata: UnsafeMutableRawPointer?)
    -> Int32
  {
    lock.lock()
    defer { lock.unlock() }

    if running { return fail("System audio capture is already running.", -2) }
    lastError = nil

    // 1. Resolve our own process's audio object so the tap can exclude it.
    //    Without this Ghostly's feedback sounds land in the meeting transcript.
    guard let selfObject = translateCurrentProcessToAudioObject() else {
      return fail("Could not resolve this process's CoreAudio process object.", -3)
    }

    // 2. Create a mono global tap excluding ourselves. Mono because the whole
    //    downstream pipeline is 16 kHz mono — letting CoreAudio do the mixdown
    //    is cheaper and better than summing channels ourselves.
    let description = CATapDescription(monoGlobalTapButExcludeProcesses: [selfObject])
    description.name = kGhostlyTapName
    description.uuid = UUID()
    // Private: the tap is not published to other apps' device lists.
    description.isPrivate = true
    // Unmuted: tapping must not silence the meeting for the user.
    description.muteBehavior = .unmuted

    var newTapID = AudioObjectID(kAudioObjectUnknown)
    let tapStatus = AudioHardwareCreateProcessTap(description, &newTapID)
    guard tapStatus == noErr, newTapID != AudioObjectID(kAudioObjectUnknown) else {
      return fail(
        "Creating the audio tap failed (OSStatus \(tapStatus)). This usually means macOS denied "
          + "system audio recording for Ghostly.", -4)
    }
    tapID = newTapID

    // 3. Read back the tap's UID and native format.
    guard let tapUID = stringProperty(of: tapID, selector: kAudioTapPropertyUID) else {
      teardownLocked()
      return fail("Could not read the audio tap's UID.", -5)
    }
    guard let format = streamFormat(of: tapID) else {
      teardownLocked()
      return fail("Could not read the audio tap's stream format.", -5)
    }
    nativeSampleRate = format.mSampleRate
    guard nativeSampleRate > 0 else {
      teardownLocked()
      return fail("Audio tap reported an invalid sample rate.", -5)
    }

    // 4. A tap has no clock of its own, so it rides on an aggregate device
    //    clocked by the current default output device.
    guard let outputUID = defaultOutputDeviceUID() else {
      teardownLocked()
      return fail("No default output device is available to clock the capture.", -6)
    }

    let aggregateUID = UUID().uuidString
    let aggregateDescription: [String: Any] = [
      kAudioAggregateDeviceNameKey: kGhostlyAggregateName,
      kAudioAggregateDeviceUIDKey: aggregateUID,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [
        [kAudioSubDeviceUIDKey: outputUID]
      ],
      kAudioAggregateDeviceTapListKey: [
        [
          kAudioSubTapDriftCompensationKey: true,
          kAudioSubTapUIDKey: tapUID,
        ]
      ],
    ]

    var newAggregateID = AudioObjectID(kAudioObjectUnknown)
    let aggregateStatus = AudioHardwareCreateAggregateDevice(
      aggregateDescription as CFDictionary, &newAggregateID)
    guard aggregateStatus == noErr, newAggregateID != AudioObjectID(kAudioObjectUnknown) else {
      teardownLocked()
      return fail("Creating the aggregate capture device failed (OSStatus \(aggregateStatus)).", -7)
    }
    aggregateID = newAggregateID

    // 5. Install the IOProc. The block runs on a CoreAudio render thread.
    let sampleRateForCallback = nativeSampleRate
    var newProcID: AudioDeviceIOProcID?
    let procStatus = AudioDeviceCreateIOProcIDWithBlock(
      &newProcID, aggregateID, ioQueue
    ) { [weak self] _, inInputData, _, _, _ in
      guard let self else { return }
      self.deliver(
        bufferList: inInputData, sampleRate: sampleRateForCallback, callback: callback,
        userdata: userdata)
    }
    guard procStatus == noErr, let procID = newProcID else {
      teardownLocked()
      return fail("Installing the audio IO callback failed (OSStatus \(procStatus)).", -8)
    }
    ioProcID = procID

    let startStatus = AudioDeviceStart(aggregateID, procID)
    guard startStatus == noErr else {
      teardownLocked()
      return fail("Starting system audio capture failed (OSStatus \(startStatus)).", -8)
    }

    running = true
    return 0
  }

  func stop() {
    lock.lock()
    defer { lock.unlock() }
    teardownLocked()
    running = false
  }

  // MARK: Audio thread

  /// Flattens the incoming buffer list to mono float32 and hands it to Rust.
  ///
  /// The tap is a mono mixdown, so the common path is a single 1-channel
  /// buffer that we forward without copying. The interleaved and
  /// multi-buffer cases are handled defensively — CoreAudio can hand back a
  /// different layout after a device change.
  private func deliver(
    bufferList: UnsafePointer<AudioBufferList>,
    sampleRate: Double,
    callback: @escaping GhostlySystemAudioCallback,
    userdata: UnsafeMutableRawPointer?
  ) {
    let buffers = UnsafeMutableAudioBufferListPointer(
      UnsafeMutablePointer(mutating: bufferList))
    guard buffers.count > 0 else { return }

    let first = buffers[0]
    guard let rawData = first.mData else { return }
    let channels = Int(first.mNumberChannels)
    guard channels > 0 else { return }

    let totalFloats = Int(first.mDataByteSize) / MemoryLayout<Float>.size
    guard totalFloats > 0 else { return }
    let frames = totalFloats / channels
    guard frames > 0 else { return }

    let source = rawData.assumingMemoryBound(to: Float.self)

    if channels == 1 {
      callback(source, Int32(frames), sampleRate, userdata)
      return
    }

    // Interleaved multi-channel: average down to mono into the reusable
    // scratch buffer. Growing it here is a rare, bounded event (only when the
    // hardware buffer size increases), not a per-callback allocation.
    if monoScratch.count < frames {
      monoScratch = [Float](repeating: 0, count: frames * 2)
    }
    monoScratch.withUnsafeMutableBufferPointer { scratch in
      guard let base = scratch.baseAddress else { return }
      let scale = 1.0 / Float(channels)
      for frame in 0..<frames {
        var sum: Float = 0
        let offset = frame * channels
        for channel in 0..<channels {
          sum += source[offset + channel]
        }
        base[frame] = sum * scale
      }
      callback(base, Int32(frames), sampleRate, userdata)
    }
  }

  // MARK: Teardown

  /// Caller must hold `lock`.
  private func teardownLocked() {
    if aggregateID != AudioObjectID(kAudioObjectUnknown) {
      if let procID = ioProcID {
        AudioDeviceStop(aggregateID, procID)
        AudioDeviceDestroyIOProcID(aggregateID, procID)
      }
      AudioHardwareDestroyAggregateDevice(aggregateID)
      aggregateID = AudioObjectID(kAudioObjectUnknown)
    }
    ioProcID = nil

    if tapID != AudioObjectID(kAudioObjectUnknown) {
      if #available(macOS 14.2, *) {
        AudioHardwareDestroyProcessTap(tapID)
      }
      tapID = AudioObjectID(kAudioObjectUnknown)
    }
    nativeSampleRate = 0
  }

  // MARK: CoreAudio property helpers

  private func translateCurrentProcessToAudioObject() -> AudioObjectID? {
    var pid = getpid()
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var objectID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)

    let status = withUnsafeMutablePointer(to: &pid) { pidPointer -> OSStatus in
      AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        UInt32(MemoryLayout<pid_t>.size),
        pidPointer,
        &size,
        &objectID)
    }
    guard status == noErr, objectID != AudioObjectID(kAudioObjectUnknown) else { return nil }
    return objectID
  }

  private func stringProperty(of object: AudioObjectID, selector: AudioObjectPropertySelector)
    -> String?
  {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString? = nil
    let status = withUnsafeMutablePointer(to: &value) { pointer -> OSStatus in
      AudioObjectGetPropertyData(object, &address, 0, nil, &size, pointer)
    }
    guard status == noErr, let value else { return nil }
    return value as String
  }

  private func streamFormat(of object: AudioObjectID) -> AudioStreamBasicDescription? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyFormat,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var format = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &format)
    guard status == noErr else { return nil }
    return format
  }

  private func defaultOutputDeviceUID() -> String? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultOutputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
    guard status == noErr, deviceID != AudioDeviceID(kAudioObjectUnknown) else { return nil }
    return stringProperty(of: deviceID, selector: kAudioDevicePropertyDeviceUID)
  }
}

// MARK: - C entry points

@_cdecl("ghostly_system_audio_supported")
public func ghostlySystemAudioSupported() -> Int32 {
  if #available(macOS 14.2, *) {
    return 1
  }
  return 0
}

@_cdecl("ghostly_system_audio_start")
public func ghostlySystemAudioStart(
  _ callback: GhostlySystemAudioCallback?,
  _ userdata: UnsafeMutableRawPointer?
) -> Int32 {
  guard let callback else { return -1 }
  guard #available(macOS 14.2, *) else { return -1 }
  return SystemAudioCapture.shared.start(callback: callback, userdata: userdata)
}

@_cdecl("ghostly_system_audio_stop")
public func ghostlySystemAudioStop() {
  SystemAudioCapture.shared.stop()
}

@_cdecl("ghostly_system_audio_is_running")
public func ghostlySystemAudioIsRunning() -> Int32 {
  return SystemAudioCapture.shared.isRunning() ? 1 : 0
}

@_cdecl("ghostly_system_audio_sample_rate")
public func ghostlySystemAudioSampleRate() -> Double {
  return SystemAudioCapture.shared.sampleRate()
}

@_cdecl("ghostly_system_audio_last_error")
public func ghostlySystemAudioLastError() -> UnsafeMutablePointer<CChar>? {
  guard let message = SystemAudioCapture.shared.takeLastError() else { return nil }
  return duplicateCString(message)
}

// MARK: - Meeting detection

/// Reads a CFString property off an audio object.
private func audioObjectString(
  _ object: AudioObjectID, _ selector: AudioObjectPropertySelector
) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<CFString?>.size)
  var value: CFString? = nil
  let status = withUnsafeMutablePointer(to: &value) { pointer -> OSStatus in
    AudioObjectGetPropertyData(object, &address, 0, nil, &size, pointer)
  }
  guard status == noErr, let value else { return nil }
  return value as String
}

/// Reads a UInt32 boolean property off an audio object.
private func audioObjectFlag(
  _ object: AudioObjectID, _ selector: AudioObjectPropertySelector
) -> Bool {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
  return status == noErr && value != 0
}

@_cdecl("ghostly_processes_using_microphone")
public func ghostlyProcessesUsingMicrophone() -> UnsafeMutablePointer<CChar>? {
  guard #available(macOS 14.2, *) else { return duplicateCString("") }

  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)

  var dataSize: UInt32 = 0
  var status = AudioObjectGetPropertyDataSize(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize)
  guard status == noErr, dataSize > 0 else { return duplicateCString("") }

  let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
  var objects = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
  status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &objects)
  guard status == noErr else { return duplicateCString("") }

  let ownBundleID = Bundle.main.bundleIdentifier

  var active: [String] = []
  for object in objects {
    guard audioObjectFlag(object, kAudioProcessPropertyIsRunningInput) else { continue }
    guard let bundleID = audioObjectString(object, kAudioProcessPropertyBundleID),
      !bundleID.isEmpty
    else { continue }
    // Exclude ourselves: Ghostly's own microphone stream must never be read as
    // evidence that a meeting is under way.
    if let ownBundleID, bundleID == ownBundleID { continue }
    if !active.contains(bundleID) { active.append(bundleID) }
  }

  return duplicateCString(active.joined(separator: "\n"))
}

@_cdecl("ghostly_system_audio_free_string")
public func ghostlySystemAudioFreeString(_ value: UnsafeMutablePointer<CChar>?) {
  guard let value else { return }
  free(value)
}
