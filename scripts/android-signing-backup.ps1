# Portable signing backup: PBKDF2-SHA256 + AES-256-CBC + encrypt-then-HMAC-SHA256.
# Functions are loaded by android-signing.ps1; no secrets are emitted to the pipeline.
function Get-OnrSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}

function Get-OnrSecretText([Security.SecureString]$Value) {
    if (!$Value) { throw 'A private passphrase is required.' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Test-OnrEqualBytes([byte[]]$Left, [byte[]]$Right) {
    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($i = 0; $i -lt $Left.Length; $i++) { $difference = $difference -bor ($Left[$i] -bxor $Right[$i]) }
    return $difference -eq 0
}

function Get-OnrDerivedKeys([Security.SecureString]$Passphrase, [byte[]]$Salt, [int]$Iterations) {
    $text = Get-OnrSecretText $Passphrase
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $text = $null
    $derive = $null
    try {
        $derive = New-Object Security.Cryptography.Rfc2898DeriveBytes($bytes, $Salt, $Iterations, [Security.Cryptography.HashAlgorithmName]::SHA256)
        return ,$derive.GetBytes(64)
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        if ($derive) { $derive.Dispose() }
    }
}

function Get-OnrAuthenticationBytes($Envelope) {
    $canonical = "ONR-ANDROID-SIGNING-BACKUP`n1`nPBKDF2-HMAC-SHA256`n$($Envelope.iterations)`n$($Envelope.salt)`n$($Envelope.iv)`n$($Envelope.ciphertext)"
    return ,[Text.Encoding]::UTF8.GetBytes($canonical)
}

function Assert-OnrPrivatePath([string]$Path, [switch]$ArchiveDirectory) {
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $blocked = @($workspace, (Split-Path $workspace -Parent), $env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)
    foreach ($location in $blocked) {
        if (!$location) { continue }
        $basePath = [IO.Path]::GetFullPath($location).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if ($fullPath.Equals($basePath, [StringComparison]::OrdinalIgnoreCase) -or $fullPath.StartsWith($basePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Signing backups and restored keys must stay outside the workspace and OneDrive.' }
    }
    if ($ArchiveDirectory) {
        $basePath = [IO.Path]::GetFullPath($SigningDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if ($fullPath.Equals($basePath, [StringComparison]::OrdinalIgnoreCase) -or $fullPath.StartsWith($basePath + '\', [StringComparison]::OrdinalIgnoreCase) -or $basePath.StartsWith($fullPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The backup directory must be independent of the signing directory.' }
    }
    $ancestor = $fullPath
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Do not use links or redirected directories for private signing material.' }
        $ancestor = Split-Path $ancestor -Parent
    }
    return $fullPath
}

function Get-OnrPinnedCertificate {
    $pin = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'android-release-certificate.sha256')).Trim()
    if ($pin -notmatch '^[a-f0-9]{64}$') { throw 'Invalid public release certificate pin.' }
    return $pin
}

function Test-OnrKeystore([string]$Path, [string]$KeyAlias, [string]$Password) {
    if ($KeyAlias -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid signing alias.' }
    $keytool = (Get-Command keytool -ErrorAction Stop).Source
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $keytool
    $start.Arguments = '-exportcert -keystore "' + $Path + '" -alias ' + $KeyAlias + ' -storepass:env ONR_BACKUP_STORE_PASSWORD'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['ONR_BACKUP_STORE_PASSWORD'] = $Password
    $process = [Diagnostics.Process]::Start($start)
    $stream = New-Object IO.MemoryStream
    try {
        $process.StandardOutput.BaseStream.CopyTo($stream)
        $discardedError = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw 'Restored keystore could not be opened. No restored material will be retained.' }
        $certificate = $stream.ToArray()
        if ((Get-OnrSha256 $certificate) -ne (Get-OnrPinnedCertificate)) { throw 'Restored certificate differs from the public release pin.' }
        return ,$certificate
    } finally { $stream.Dispose(); $process.Dispose(); $start.EnvironmentVariables.Remove('ONR_BACKUP_STORE_PASSWORD') }
}

function Read-OnrBackupPayload([string]$Archive, [Security.SecureString]$Passphrase) {
    $item = Get-Item -LiteralPath $Archive
    if ($item.Length -gt 131072) { throw 'Signing backup is unexpectedly large.' }
    $envelope = [IO.File]::ReadAllText($item.FullName) | ConvertFrom-Json
    if ($envelope.format -ne 'ONR-ANDROID-SIGNING-BACKUP' -or $envelope.version -ne 1 -or $envelope.kdf -ne 'PBKDF2-HMAC-SHA256' -or $envelope.cipher -ne 'AES-256-CBC-HMAC-SHA256' -or $envelope.iterations -ne 600000) { throw 'Unsupported signing backup format.' }
    try {
        $salt = [Convert]::FromBase64String($envelope.salt)
        $iv = [Convert]::FromBase64String($envelope.iv)
        $ciphertext = [Convert]::FromBase64String($envelope.ciphertext)
        $tag = [Convert]::FromBase64String($envelope.mac)
    } catch { throw 'Invalid signing backup encoding.' }
    if ($salt.Length -ne 32 -or $iv.Length -ne 16 -or $tag.Length -ne 32 -or !$ciphertext.Length -or $ciphertext.Length % 16) { throw 'Invalid signing backup fields.' }
    $keys = Get-OnrDerivedKeys $Passphrase $salt 600000
    $aes = [Security.Cryptography.Aes]::Create()
    $hmac = New-Object Security.Cryptography.HMACSHA256(,[byte[]]$keys[32..63])
    $plain = $null
    try {
        $actual = $hmac.ComputeHash((Get-OnrAuthenticationBytes $envelope))
        if (!(Test-OnrEqualBytes $tag $actual)) { throw 'Backup passphrase is incorrect or the archive was modified.' }
        # Authenticate the whole envelope before attempting CBC decryption.
        $aes.KeySize = 256
        $aes.Mode = [Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
        $aes.Key = [byte[]]$keys[0..31]
        $aes.IV = $iv
        $decryptor = $aes.CreateDecryptor()
        try { $plain = $decryptor.TransformFinalBlock($ciphertext, 0, $ciphertext.Length) } finally { $decryptor.Dispose() }
        $payload = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
        if ($payload.version -ne 1 -or $payload.applicationId -ne 'io.github.opennovelreader.app' -or $payload.certificateSha256 -ne (Get-OnrPinnedCertificate) -or !$payload.alias -or !$payload.password -or !$payload.keystore) { throw 'Backup payload does not match this application and release certificate.' }
        return $payload
    } finally {
        if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
        [Array]::Clear($keys, 0, $keys.Length)
        $aes.Dispose(); $hmac.Dispose()
    }
}

function Remove-OnrRestoreMaterials([string]$Directory, [switch]$RemoveDirectory) {
    # Only known files are removed; never recurse or delete an unverified target.
    $safePath = Assert-OnrPrivatePath $Directory
    foreach ($name in @('android-release.jks', 'android-release.credential.xml', 'android-release.cer')) {
        $path = Join-Path $safePath $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    if ($RemoveDirectory -and (Test-Path -LiteralPath $safePath)) { [IO.Directory]::Delete($safePath, $false) }
}

function Restore-OnrSigningBackup([string]$Archive, [Security.SecureString]$Passphrase, [string]$Destination) {
    $destinationPath = Assert-OnrPrivatePath $Destination
    if ((Test-Path -LiteralPath $destinationPath) -and (Get-ChildItem -LiteralPath $destinationPath -Force | Select-Object -First 1)) { throw 'Restore destination must be empty. Existing keys are never overwritten.' }
    $payload = Read-OnrBackupPayload $Archive $Passphrase
    Protect-SigningDirectory $destinationPath
    $restoredKey = Join-Path $destinationPath 'android-release.jks'
    try {
        $bytes = [Convert]::FromBase64String($payload.keystore)
        [IO.File]::WriteAllBytes($restoredKey, $bytes)
        [Array]::Clear($bytes, 0, $bytes.Length)
        $certificate = Test-OnrKeystore $restoredKey $payload.alias $payload.password
        [IO.File]::WriteAllBytes((Join-Path $destinationPath 'android-release.cer'), $certificate)
        $secure = ConvertTo-SecureString -String $payload.password -AsPlainText -Force
        $restoredCredential = New-Object Management.Automation.PSCredential($payload.alias, $secure)
        $restoredCredential | Export-Clixml -LiteralPath (Join-Path $destinationPath 'android-release.credential.xml')
    } catch {
        Remove-OnrRestoreMaterials $destinationPath
        throw 'Restore failed. Temporary key material was removed; the encrypted archive and original signing key remain unchanged.'
    } finally { if ($payload) { $payload.password = $null; $payload.keystore = $null } }
}

function New-OnrSigningBackup([Security.SecureString]$Passphrase, [Security.SecureString]$Confirmation, [bool]$Interactive) {
    if (!$Passphrase -or !$Confirmation) { throw 'Both private passphrase inputs are required.' }
    $first = Get-OnrSecretText $Passphrase
    $second = Get-OnrSecretText $Confirmation
    try {
        if ($first.Length -lt 16) { throw 'Use a unique passphrase of at least 16 characters.' }
        $firstBytes = [Text.Encoding]::UTF8.GetBytes($first)
        $secondBytes = [Text.Encoding]::UTF8.GetBytes($second)
        if (!(Test-OnrEqualBytes $firstBytes $secondBytes)) { throw 'The passphrase confirmation does not match. No backup was created.' }
    } finally {
        $first = $null; $second = $null
        if ($firstBytes) { [Array]::Clear($firstBytes, 0, $firstBytes.Length) }
        if ($secondBytes) { [Array]::Clear($secondBytes, 0, $secondBytes.Length) }
    }
    $archiveDirectory = Assert-OnrPrivatePath $BackupDirectory -ArchiveDirectory
    Protect-SigningDirectory $archiveDirectory
    if (!$BackupPath) { $BackupPath = Join-Path $archiveDirectory ('android-release-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.onr-signing-backup') }
    $archivePath = [IO.Path]::GetFullPath($BackupPath)
    if (!(Split-Path $archivePath -Parent).Equals($archiveDirectory, [StringComparison]::OrdinalIgnoreCase)) { throw 'The archive must be directly inside the protected backup directory.' }
    if (Test-Path -LiteralPath $archivePath) { throw 'Backup archive already exists; existing archives are never overwritten.' }
    $credential = Read-SigningCredential
    $password = $credential.GetNetworkCredential().Password
    $null = Test-OnrKeystore $keyFile $credential.UserName $password
    $payload = @{ version = 1; applicationId = 'io.github.opennovelreader.app'; alias = $credential.UserName; password = $password; keystore = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyFile)); certificateSha256 = (Get-OnrPinnedCertificate) }
    $plain = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
    $payload.password = $null; $payload.keystore = $null; $password = $null
    $salt = New-Object byte[] 32
    $iv = New-Object byte[] 16
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($salt); $rng.GetBytes($iv) } finally { $rng.Dispose() }
    $keys = Get-OnrDerivedKeys $Passphrase $salt 600000
    $aes = [Security.Cryptography.Aes]::Create()
    $hmac = New-Object Security.Cryptography.HMACSHA256(,[byte[]]$keys[32..63])
    try {
        $aes.KeySize = 256
        $aes.Mode = [Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
        $aes.Key = [byte[]]$keys[0..31]
        $aes.IV = $iv
        $encryptor = $aes.CreateEncryptor()
        try { $ciphertext = $encryptor.TransformFinalBlock($plain, 0, $plain.Length) } finally { $encryptor.Dispose() }
        $envelope = [ordered]@{ format = 'ONR-ANDROID-SIGNING-BACKUP'; version = 1; kdf = 'PBKDF2-HMAC-SHA256'; iterations = 600000; cipher = 'AES-256-CBC-HMAC-SHA256'; salt = [Convert]::ToBase64String($salt); iv = [Convert]::ToBase64String($iv); ciphertext = [Convert]::ToBase64String($ciphertext) }
        $envelope.mac = [Convert]::ToBase64String($hmac.ComputeHash((Get-OnrAuthenticationBytes $envelope)))
        $file = New-Object IO.FileStream($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $data = [Text.Encoding]::UTF8.GetBytes(($envelope | ConvertTo-Json)); $file.Write($data, 0, $data.Length) } finally { $file.Dispose() }
    } finally { [Array]::Clear($plain, 0, $plain.Length); [Array]::Clear($keys, 0, $keys.Length); $aes.Dispose(); $hmac.Dispose() }
    $temporary = Join-Path $archiveDirectory ('.restore-check-' + [Guid]::NewGuid().ToString('N'))
    try {
        Restore-OnrSigningBackup -Archive $archivePath -Passphrase $Passphrase -Destination $temporary
        if ((Get-OnrSha256 ([IO.File]::ReadAllBytes((Join-Path $temporary 'android-release.jks')))) -ne (Get-OnrSha256 ([IO.File]::ReadAllBytes($keyFile)))) { throw 'Restored private keystore bytes do not match the original.' }
        $reloaded = Import-Clixml -LiteralPath (Join-Path $temporary 'android-release.credential.xml')
        $null = Test-OnrKeystore (Join-Path $temporary 'android-release.jks') $reloaded.UserName $reloaded.GetNetworkCredential().Password
    } finally { Remove-OnrRestoreMaterials $temporary -RemoveDirectory }
    $receipt = @{ success = $true; backupPath = $archivePath; backupSha256 = (Get-OnrSha256 ([IO.File]::ReadAllBytes($archivePath))); certificateSha256 = (Get-OnrPinnedCertificate) }
    $receiptPath = if ($Interactive) { Join-Path $archiveDirectory 'android-release-backup.receipt.json' } else { $archivePath + '.test.receipt.json' }
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Write-Output 'Backup and independent restore verification succeeded. Temporary restored material was removed.'
    Write-Output "Encrypted archive: $archivePath"
    Write-Output "Receipt: $receiptPath"
    Write-Output ('Public certificate SHA256: ' + (Get-OnrPinnedCertificate))
    if (!$Interactive) { Write-Output 'Injected SecureString test: this receipt does not authorize publishing GitHub Secrets.' }
}

function Assert-OnrVerifiedBackup {
    $directory = Assert-OnrPrivatePath $BackupDirectory -ArchiveDirectory
    $receiptPath = Join-Path $directory 'android-release-backup.receipt.json'
    if (!(Test-Path -LiteralPath $receiptPath)) { throw 'Complete an interactive backup with two hidden local passphrase inputs before publishing GitHub Secrets.' }
    $receipt = [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
    if (!$receipt.success -or $receipt.certificateSha256 -ne (Get-OnrPinnedCertificate) -or !(Test-Path -LiteralPath $receipt.backupPath) -or $receipt.backupSha256 -ne (Get-OnrSha256 ([IO.File]::ReadAllBytes($receipt.backupPath)))) { throw 'The verified backup receipt or encrypted archive is missing or changed. Complete a fresh interactive backup first.' }
}
