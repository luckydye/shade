import Photos
import UIKit

struct PhotoEntry: Codable {
    let id: String
    let modified_at: UInt64?
}

// Returns a heap-allocated JSON array of photo entries, sorted newest-first.
// Requests photo library permission if not yet determined.
// Caller must free with ios_free_string. Returns nil on permission denied.
@_cdecl("ios_list_photos")
public func iosListPhotos() -> UnsafeMutablePointer<CChar>? {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if status == .notDetermined {
        let semaphore = DispatchSemaphore(value: 0)
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in semaphore.signal() }
        semaphore.wait()
    }

    let newStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard newStatus == .authorized || newStatus == .limited else { return nil }

    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "modificationDate", ascending: false)]
    let assets = PHAsset.fetchAssets(with: .image, options: options)

    var photos: [PhotoEntry] = []
    assets.enumerateObjects { asset, _, _ in
        let modifiedAt = asset.modificationDate ?? asset.creationDate
        photos.append(PhotoEntry(
            id: asset.localIdentifier,
            modified_at: modifiedAt.map { UInt64($0.timeIntervalSince1970 * 1000) }
        ))
    }

    guard let data = try? JSONEncoder().encode(photos),
          let json = String(data: data, encoding: .utf8) else { return nil }
    return strdup(json)
}

// Returns heap-allocated JPEG thumbnail bytes. Caller must free with ios_free_buffer.
@_cdecl("ios_get_thumbnail")
public func iosGetThumbnail(
    _ identifier: UnsafePointer<CChar>,
    _ width: Int32,
    _ height: Int32,
    _ outSize: UnsafeMutablePointer<Int32>
) -> UnsafeMutablePointer<UInt8>? {
    let id = String(cString: identifier)
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
    guard let asset = fetchResult.firstObject else { return nil }

    var resultData: Data?

    let options = PHImageRequestOptions()
    options.isSynchronous = true
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    options.isNetworkAccessAllowed = true

    PHImageManager.default().requestImage(
        for: asset,
        targetSize: CGSize(width: CGFloat(width), height: CGFloat(height)),
        contentMode: .aspectFit,
        options: options
    ) { image, _ in resultData = image?.jpegData(compressionQuality: 0.82) }

    guard let data = resultData else { return nil }
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: data.count)
    data.copyBytes(to: buffer, count: data.count)
    outSize.pointee = Int32(data.count)
    return buffer
}

// Returns heap-allocated original image bytes (HEIC/JPEG/RAW etc).
// Caller must free with ios_free_buffer.
@_cdecl("ios_get_image_data")
public func iosGetImageData(
    _ identifier: UnsafePointer<CChar>,
    _ outSize: UnsafeMutablePointer<Int32>
) -> UnsafeMutablePointer<UInt8>? {
    let id = String(cString: identifier)
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
    guard let asset = fetchResult.firstObject else { return nil }

    let options = PHImageRequestOptions()
    options.isSynchronous = true
    options.deliveryMode = .highQualityFormat
    options.isNetworkAccessAllowed = true

    var resultData: Data?
    PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
        resultData = data
    }

    guard let data = resultData else { return nil }
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: data.count)
    data.copyBytes(to: buffer, count: data.count)
    outSize.pointee = Int32(data.count)
    return buffer
}

@_cdecl("ios_free_buffer")
public func iosFreeBuffer(_ ptr: UnsafeMutablePointer<UInt8>) {
    ptr.deallocate()
}

@_cdecl("ios_free_string")
public func iosFreeString(_ ptr: UnsafeMutablePointer<CChar>) {
    free(ptr)
}
