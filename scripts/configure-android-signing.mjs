import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const gradlePath = join(root, 'src-tauri/gen/android/app/build.gradle.kts');
const marker = '// Open Novel Reader persistent release signing';
for (const name of ['ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
  if (!process.env[name]?.trim()) throw new Error(`Missing ${name}; release signing must be configured before building.`);
}
let keyPath = process.env.ANDROID_KEYSTORE_PATH;
if (!keyPath) {
  const encoded = process.env.ANDROID_KEY_BASE64?.replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Missing or invalid ANDROID_KEY_BASE64.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 256 || bytes.toString('base64') !== encoded) throw new Error('Invalid signing keystore encoding.');
  if (!process.env.RUNNER_TEMP) throw new Error('Set ANDROID_KEYSTORE_PATH locally, or RUNNER_TEMP in CI.');
  keyPath = join(process.env.RUNNER_TEMP, 'open-novel-reader-release.jks');
  writeFileSync(keyPath, bytes, { mode: 0o600, flag: 'wx' });
}
keyPath = resolve(keyPath);
if (!existsSync(keyPath)) throw new Error('Configured Android keystore does not exist.');
const gradle = readFileSync(gradlePath, 'utf8');
if (!gradle.includes('buildTypes {') || !gradle.includes('getByName("release")')) {
  throw new Error('Generated Android Gradle template changed; review signing setup before releasing.');
}
if (!gradle.includes(marker)) {
  if (gradle.includes('signingConfigs')) throw new Error('Existing Android signing configuration requires manual review.');
  writeFileSync(gradlePath, `${gradle.trimEnd()}\n\n${marker}
android {
    signingConfigs {
        create("release") {
            storeFile = file(requireNotNull(System.getenv("ANDROID_KEYSTORE_PATH")))
            storePassword = requireNotNull(System.getenv("ANDROID_KEY_PASSWORD"))
            keyAlias = requireNotNull(System.getenv("ANDROID_KEY_ALIAS"))
            keyPassword = requireNotNull(System.getenv("ANDROID_KEY_PASSWORD"))
        }
    }
    buildTypes.getByName("release") {
        signingConfig = signingConfigs.getByName("release")
        isDebuggable = false
        isJniDebuggable = false
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }
}
`);
}
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `ANDROID_KEYSTORE_PATH=${keyPath}\n`);
console.log('Generated Android project configured for the persistent release keystore. No passwords were written to Gradle or logs.');
