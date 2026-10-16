// @draftroom/board-archive (wave R, WS4; docs/WAVE-R-CONTRACTS.md §5): the `.lobby` backup's ZIP writer and reader on
// node:zlib (no dependency) and its manifest. Node only. Used by the api (features/backup): the download streams
// `writeBackup`, a restore reads the spooled upload through `openBackup` over byte ranges.
export {
  BACKUP_MAX_RATIO,
  BACKUP_READ_LIMITS,
  type BackupErrorCode,
  type BackupFileInput,
  BackupFormatError,
  type BackupInput,
  backupManifest,
  type OpenedBackup,
  openBackup,
  readBackupBoard,
  streamBackupFile,
  writeBackup,
} from './backup.ts'
export {
  bufferSource,
  fileSource,
  type RangeSource,
  readZipDirectory,
  readZipEntry,
  streamZipEntry,
  unsafeEntryName,
  type ZipEntry,
  ZipFormatError,
  type ZipReadLimits,
} from './zip-read.ts'
export {
  dosDateTime,
  ZIP_MAX_ENTRIES,
  type ZipWriteEntry,
  ZipWriteError,
  zipStream,
  zipToBuffer,
} from './zip-write.ts'
