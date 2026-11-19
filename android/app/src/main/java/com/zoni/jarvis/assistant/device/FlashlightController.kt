package com.zoni.jarvis.assistant.device

import android.content.Context
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager

sealed class FlashlightResult {
    data class Success(val isEnabled: Boolean) : FlashlightResult()
    object HardwareUnavailable : FlashlightResult()
    object PermissionDenied : FlashlightResult()
    data class Error(val message: String) : FlashlightResult()
}

class FlashlightController(private val context: Context) {

    private val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
    private var torchCameraId: String? = null
    private var isTorchOn: Boolean = false

    init {
        resolveTorchCamera()
        registerTorchCallback()
    }

    private fun registerTorchCallback() {
        try {
            cameraManager?.registerTorchCallback(object : CameraManager.TorchCallback() {
                override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
                    if (cameraId == torchCameraId) {
                        isTorchOn = enabled
                    }
                }

                override fun onTorchModeUnavailable(cameraId: String) {
                    if (cameraId == torchCameraId) {
                        isTorchOn = false
                    }
                }
            }, null)
        } catch (e: Exception) {
            // Ignore in environments where TorchCallback registration is not permitted
        }
    }

    private fun resolveTorchCamera() {
        if (cameraManager == null) return
        try {
            for (id in cameraManager.cameraIdList) {
                val characteristics = cameraManager.getCameraCharacteristics(id)
                val hasFlash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
                val facing = characteristics.get(CameraCharacteristics.LENS_FACING)
                if (hasFlash && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    torchCameraId = id
                    break
                }
            }
            if (torchCameraId == null && cameraManager.cameraIdList.isNotEmpty()) {
                // Fallback to any camera with flash
                for (id in cameraManager.cameraIdList) {
                    val characteristics = cameraManager.getCameraCharacteristics(id)
                    val hasFlash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
                    if (hasFlash) {
                        torchCameraId = id
                        break
                    }
                }
            }
        } catch (e: Exception) {
            torchCameraId = null
        }
    }

    fun setFlashlight(enable: Boolean): FlashlightResult {
        val manager = cameraManager ?: return FlashlightResult.HardwareUnavailable
        val camId = torchCameraId ?: run {
            resolveTorchCamera()
            torchCameraId
        } ?: return FlashlightResult.HardwareUnavailable

        // If already in target state, return Success directly
        if (isTorchOn == enable) {
            return FlashlightResult.Success(isEnabled = enable)
        }

        return try {
            manager.setTorchMode(camId, enable)
            isTorchOn = enable
            FlashlightResult.Success(isEnabled = enable)
        } catch (e: CameraAccessException) {
            FlashlightResult.Error("ক্যামেরা হার্ডওয়্যার অ্যাক্সেস ত্রুটি: ${e.message}")
        } catch (e: SecurityException) {
            FlashlightResult.PermissionDenied
        } catch (e: Exception) {
            FlashlightResult.Error("ফ্ল্যাশলাইট চালাতে ব্যর্থ: ${e.message}")
        }
    }

    fun isCurrentlyOn(): Boolean = isTorchOn
}
