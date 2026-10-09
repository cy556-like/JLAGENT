"""Build a small signed APK using only official JDK/Android build tools."""
import argparse
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
import zipfile


def main():
    parser = argparse.ArgumentParser()
    for name in ('java-bin', 'build-tools', 'android-jar', 'keystore', 'password-file', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    java = Path(args.java_bin).resolve()
    tools = Path(args.build_tools).resolve()
    platform = Path(args.android_jar).resolve()
    key = Path(args.keystore).resolve()
    password = Path(args.password_file).resolve()
    output = Path(args.output).resolve()
    assert not key.is_relative_to(source), 'Keep private signing keys outside the project'
    assert not password.is_relative_to(source), 'Keep signing passwords outside the project'
    build = source / 'build'
    classes = build / 'classes'
    dex = build / 'dex'
    for folder in (classes, dex, key.parent, password.parent, output.parent):
        folder.mkdir(parents=True, exist_ok=True)

    def executable(folder, name):
        return str(folder / (name + ('.exe' if os.name == 'nt' else '')))

    def run(command):
        subprocess.run(command, check=True)

    run([executable(java, 'javac'), '-encoding', 'UTF-8', '-source', '8', '-target', '8',
         '-bootclasspath', str(platform), '-d', str(classes),
         *map(str, sorted((source / 'src').rglob('*.java')))])
    run([executable(java, 'java'), '-cp', str(tools / 'lib/d8.jar'), 'com.android.tools.r8.D8',
         '--min-api', '23', '--lib', str(platform), '--output', str(dex),
         *map(str, sorted(classes.rglob('*.class')))])
    unsigned = build / 'unsigned.apk'
    aligned = build / 'aligned.apk'
    run([executable(tools, 'aapt'), 'package', '-f', '-M', str(source / 'AndroidManifest.xml'),
         '-S', str(source / 'res'), '-I', str(platform), '-F', str(unsigned)])
    with zipfile.ZipFile(unsigned, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(dex.glob('classes*.dex')):
            archive.write(path, path.name)
    run([executable(tools, 'zipalign'), '-f', '4', str(unsigned), str(aligned)])
    if key.exists():
        assert password.is_file(), 'Existing signing key requires its original password file'
    else:
        assert not password.exists(), 'Refusing to replace an existing password file'
        password.write_text(secrets.token_urlsafe(36), encoding='utf-8')
        run([executable(java, 'keytool'), '-genkeypair', '-keystore', str(key), '-alias', 'jlagent',
             '-storepass:file', str(password), '-keypass:file', str(password), '-keyalg', 'RSA',
             '-keysize', '3072', '-validity', '10000', '-dname', 'CN=JLAGENT Android, O=JLAGENT',
             '-storetype', 'JKS', '-noprompt'])
    signer = [executable(java, 'java'), '-jar', str(tools / 'lib/apksigner.jar')]
    run(signer + ['sign', '--ks', str(key), '--ks-key-alias', 'jlagent', '--ks-pass', 'file:' + str(password),
                  '--out', str(output), str(aligned)])
    run(signer + ['verify', '--verbose', '--print-certs', str(output)])
    run([executable(tools, 'aapt'), 'dump', 'badging', str(output)])
    print('APK:', output)
    print('Bytes:', output.stat().st_size)
    print('SHA256:', hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
