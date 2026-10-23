import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Session and PKCE persistence fail closed when secure storage is unavailable.
class SecureSessionStorage extends LocalStorage {
  const SecureSessionStorage(this.namespace,
      {this.storage = const FlutterSecureStorage()});
  final String namespace;
  final FlutterSecureStorage storage;
  String get _key => '$namespace:session';
  @override
  Future<void> initialize() async {
    await storage.containsKey(key: _key);
  }

  @override
  Future<bool> hasAccessToken() => storage.containsKey(key: _key);
  @override
  Future<String?> accessToken() => storage.read(key: _key);
  @override
  Future<void> persistSession(String value) =>
      storage.write(key: _key, value: value);
  @override
  Future<void> removePersistedSession() => storage.delete(key: _key);
}

class SecurePkceStorage extends GotrueAsyncStorage {
  const SecurePkceStorage(this.namespace,
      {this.storage = const FlutterSecureStorage()});
  final String namespace;
  final FlutterSecureStorage storage;
  @override
  Future<String?> getItem({required String key}) =>
      storage.read(key: '$namespace:pkce:$key');
  @override
  Future<void> setItem({required String key, required String value}) =>
      storage.write(key: '$namespace:pkce:$key', value: value);
  @override
  Future<void> removeItem({required String key}) =>
      storage.delete(key: '$namespace:pkce:$key');
}
