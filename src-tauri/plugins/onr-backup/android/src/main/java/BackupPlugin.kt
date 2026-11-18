package io.github.opennovelreader.backup

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException

@InvokeArg
class SaveArgs {
    lateinit var filename: String
    lateinit var archive: String
    var totalBytes: Long = 0
}

@TauriPlugin
class BackupPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun saveArchive(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveArgs::class.java)
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/zip"
                putExtra(Intent.EXTRA_TITLE, args.filename)
            }
            startActivityForResult(invoke, intent, "saveArchiveResult")
        } catch (_: Exception) {
            invoke.reject("Could not open the Android backup save dialog.")
        }
    }

    @ActivityCallback
    fun saveArchiveResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(JSObject().put("saved", false))
            return
        }
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null || uri.scheme != ContentResolver.SCHEME_CONTENT) {
            invoke.reject("The backup destination could not be opened.")
            return
        }
        Thread({
            val resolver = activity.contentResolver
            try {
                val args = invoke.parseArgs(SaveArgs::class.java)
                val archive = File(args.archive).canonicalFile
                if (archive.parentFile != activity.cacheDir.canonicalFile || !archive.name.startsWith("onr-export-") || !archive.isFile) {
                    throw IOException("Invalid backup cache file.")
                }
                val expectedSize = args.totalBytes
                if (expectedSize <= 0 || expectedSize != archive.length()) throw IOException("Incomplete backup cache file.")
                val output = resolver.openOutputStream(uri, "wt") ?: throw IOException("Unable to write document.")
                // Keep the Android-owned stream alive until all data is written.
                output.use { destination ->
                    val copiedSize = archive.inputStream().use { it.copyTo(destination) }
                    if (copiedSize != expectedSize || copiedSize == 0L) throw IOException("Incomplete backup.")
                    destination.flush()
                }
                val size = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
                    if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null
                }
                if (size != null && size != expectedSize) throw IOException("Incomplete backup.")
            } catch (_: Exception) {
                // This picker action creates a new document. Remove an incomplete
                // copy where the selected document provider allows deletion.
                runCatching { DocumentsContract.deleteDocument(resolver, uri) }
                invoke.reject("Could not write or verify the backup file.")
                return@Thread
            }
            invoke.resolve(JSObject().put("saved", true))
        }, "onr-backup-writer").start()
    }
}
