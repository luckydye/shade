package com.shade.editor

import android.Manifest
import android.content.ContentUris
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES], alias = "readMediaImages"),
        Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "readExternalStorage"),
    ]
)
class PhotosPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    private val permissionAlias get() =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "readMediaImages"
        else "readExternalStorage"

    @Command
    fun listPhotos(invoke: Invoke) {
        if (getPermissionState(permissionAlias) != PermissionState.GRANTED) {
            requestPermissionForAlias(permissionAlias, invoke, "listPhotosWithPermission")
            return
        }
        resolveListPhotos(invoke)
    }

    @PermissionCallback
    fun listPhotosWithPermission(invoke: Invoke) {
        if (getPermissionState(permissionAlias) != PermissionState.GRANTED) {
            invoke.reject("Photo library permission denied")
            return
        }
        resolveListPhotos(invoke)
    }

    private fun resolveListPhotos(invoke: Invoke) {
        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }

        val projection = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_ADDED)
        val cursor = activity.contentResolver.query(
            collection, projection, null, null,
            "${MediaStore.Images.Media.DATE_ADDED} DESC"
        )

        val arr = JSArray()
        cursor?.use {
            val idCol = it.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            while (it.moveToNext()) {
                val uri = ContentUris.withAppendedId(collection, it.getLong(idCol))
                arr.put(uri.toString())
            }
        }

        val result = JSObject()
        result.put("uris", arr)
        invoke.resolve(result)
    }

    @Command
    fun getThumbnail(invoke: Invoke) {
        val uriString = invoke.getArgs().getString("uri", null)
            ?: run { invoke.reject("missing uri"); return }
        val uri = Uri.parse(uriString)

        try {
            val bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                activity.contentResolver.loadThumbnail(uri, android.util.Size(320, 320), null)
            } else {
                val id = ContentUris.parseId(uri)
                @Suppress("DEPRECATION")
                MediaStore.Images.Thumbnails.getThumbnail(
                    activity.contentResolver, id,
                    MediaStore.Images.Thumbnails.MINI_KIND, null
                )
            } ?: run { invoke.reject("failed to load thumbnail"); return }

            val out = ByteArrayOutputStream()
            bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, out)
            val bytes = out.toByteArray()

            val arr = JSArray()
            for (b in bytes) arr.put(b.toInt() and 0xFF)
            val result = JSObject()
            result.put("bytes", arr)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "failed to load thumbnail")
        }
    }

    @Command
    fun getImageData(invoke: Invoke) {
        val uriString = invoke.getArgs().getString("uri", null)
            ?: run { invoke.reject("missing uri"); return }
        val uri = Uri.parse(uriString)

        try {
            val bytes = activity.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: run { invoke.reject("failed to open image stream"); return }

            val arr = JSArray()
            for (b in bytes) arr.put(b.toInt() and 0xFF)
            val result = JSObject()
            result.put("bytes", arr)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "failed to open image")
        }
    }
}
