import { getSharedWorker } from './workerProcess'
import { getModelDownloadRoot } from './modelManager'
import type { DeviceInfo, GpuVerificationResult } from '@shared/transcription'

export async function getDeviceInfo(): Promise<DeviceInfo> {
  const worker = getSharedWorker()
  await worker.ensureStarted()
  const { promise } = worker.send('device_info', {})
  return (await promise) as DeviceInfo
}

export async function retryGpuDetection(): Promise<DeviceInfo> {
  const worker = getSharedWorker()
  await worker.ensureStarted()
  const { promise } = worker.send('retry_gpu_detection', {})
  return (await promise) as DeviceInfo
}

export async function verifyGpu(): Promise<GpuVerificationResult> {
  const worker = getSharedWorker()
  await worker.ensureStarted()
  const { promise } = worker.send('verify_gpu', { downloadRoot: getModelDownloadRoot() })
  return (await promise) as GpuVerificationResult
}
