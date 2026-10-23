import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart' hide AuthState;

import 'api.dart';
import 'models.dart';
import 'secure_session.dart';

const mobileAuthRedirect = 'com.bookworm.ai://login-callback';

bool isMobileAuthCallback(Uri uri) =>
    uri.scheme == 'com.bookworm.ai' &&
    uri.host == 'login-callback' &&
    uri.userInfo.isEmpty &&
    !uri.hasPort &&
    uri.path.isEmpty &&
    !uri.hasFragment;

bool isPublicSupabaseKey(String key) {
  if (RegExp(r'^sb_publishable_[A-Za-z0-9_-]+$').hasMatch(key)) return true;
  final parts = key.split('.');
  if (parts.length != 3 || parts.any((part) => part.isEmpty)) return false;
  try {
    final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
    return payload is Map<String, dynamic> && payload['role'] == 'anon';
  } on FormatException {
    return false;
  }
}

Future<void> clearLegacyAuthCache(
    SharedPreferences preferences, String supabaseOrigin) async {
  // Remove only this application's obsolete plaintext session/PKCE keys.
  final project = Uri.parse(supabaseOrigin).host.split('.').first;
  for (final key in [
    'access_token',
    'workspaceId',
    'workspaceName',
    'workspaceOrgId',
    'sb-$project-auth-token',
    'supabase.auth.token-code-verifier'
  ]) {
    await preferences.remove(key);
  }
}

class AuthState extends ChangeNotifier {
  AuthState(
      {required SupabaseClient client,
      required SharedPreferences preferences,
      required String apiBaseUrl,
      required String webBaseUrl,
      http.Client Function()? clientFactory})
      : _client = client,
        _preferences = preferences,
        _apiBaseUrl = ApiClient.validateOrigin(apiBaseUrl),
        webBaseUrl = ApiClient.validateOrigin(webBaseUrl),
        _clientFactory = clientFactory;

  static Future<AuthState> init(
      {required String supabaseUrl,
      required String supabaseAnonKey,
      required String apiBaseUrl,
      required String webBaseUrl}) async {
    final origin = ApiClient.validateOrigin(supabaseUrl);
    if (ApiClient.validateOrigin(apiBaseUrl) ==
        ApiClient.validateOrigin(webBaseUrl)) {
      throw const FormatException(
          'API_BASE_URL must be the API, not the web app.');
    }
    if (!isPublicSupabaseKey(supabaseAnonKey)) {
      throw const FormatException('Configure the public Supabase client key.');
    }
    final preferences = await SharedPreferences.getInstance();
    await clearLegacyAuthCache(preferences, origin);
    final namespace = 'bookworm:${Uri.parse(origin).host}';
    await Supabase.initialize(
        url: origin,
        publishableKey: supabaseAnonKey,
        authOptions: FlutterAuthClientOptions(
            authFlowType: AuthFlowType.pkce,
            localStorage: SecureSessionStorage(namespace),
            pkceAsyncStorage: SecurePkceStorage(namespace),
            detectSessionInUriPredicate: isMobileAuthCallback));
    final state = AuthState(
        client: Supabase.instance.client,
        preferences: preferences,
        apiBaseUrl: apiBaseUrl,
        webBaseUrl: webBaseUrl);
    await state.start();
    return state;
  }

  final SupabaseClient _client;
  final SharedPreferences _preferences;
  final String _apiBaseUrl;
  final String webBaseUrl;
  final http.Client Function()? _clientFactory;
  StreamSubscription? _subscription;
  String? _ownerId;
  Workspace? _workspace;
  List<Workspace> _workspaces = const [];
  int _generation = 0, _scopeRevision = 0;
  bool _disposed = false,
      _loading = false,
      _recoveringPassword = false,
      _signingOut = false;
  String? _error;

  User? get user => _client.auth.currentUser;
  bool get signedIn => !_signingOut && user != null;
  Workspace? get workspace => _workspace;
  List<Workspace> get workspaces => _workspaces;
  bool get loading => _loading;
  bool get recoveringPassword => _recoveringPassword;
  String? get error => _error;
  String get scopeKey =>
      '${user?.id ?? 'signed-out'}:${_workspace?.id ?? 'no-workspace'}:$_scopeRevision:$_recoveringPassword';
  String get aiBaseUrl => _apiBaseUrl;
  String get storageBaseUrl => _client.storage.url;

  ApiClient? get api {
    final session = _client.auth.currentSession;
    if (_disposed ||
        _signingOut ||
        session == null ||
        session.user.id != _ownerId ||
        _recoveringPassword) return null;
    final revision = _scopeRevision;
    return ApiClient(
        baseUrl: _apiBaseUrl,
        token: session.accessToken,
        accessToken: () => _client.auth.currentSession?.accessToken ?? '',
        clientFactory: _clientFactory,
        isCurrent: () =>
            !_disposed &&
            !_signingOut &&
            _scopeRevision == revision &&
            _ownerId == session.user.id &&
            user?.id == session.user.id);
  }

  Future<void> start() async {
    _subscription ??= _client.auth.onAuthStateChange.listen((event) {
      if (_disposed) return;
      if (event.event == AuthChangeEvent.passwordRecovery)
        _recoveringPassword = true;
      if (event.event == AuthChangeEvent.signedOut) _recoveringPassword = false;
      unawaited(refreshWorkspaces());
    }, onError: (Object _) {
      if (!_disposed) _clear('Sign-in could not be restored. Sign in again.');
    });
    await refreshWorkspaces();
  }

  void _clear([String? error]) {
    ++_generation;
    ++_scopeRevision;
    _workspace = null;
    _workspaces = const [];
    _loading = false;
    _error = error;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> refreshWorkspaces() async {
    if (_disposed || _signingOut) return;
    final actor = user?.id;
    if (_ownerId != actor) {
      _ownerId = actor;
      _clear();
    }
    if (actor == null || _recoveringPassword) {
      _clear();
      return;
    }
    final generation = ++_generation;
    bool current() =>
        !_disposed &&
        generation == _generation &&
        actor == user?.id &&
        !_signingOut;
    final client = api;
    if (client == null) return;
    _loading = true;
    _error = null;
    _notify();
    try {
      final items = await client.listWorkspaces();
      if (!current()) return;
      final selectedId =
          _workspace?.id ?? _preferences.getString('bookworm:workspace:$actor');
      final matches = items.where((item) => item.id == selectedId);
      final selected = matches.isNotEmpty ? matches.first : items.firstOrNull;
      if (selected?.id != _workspace?.id) ++_scopeRevision;
      _workspaces = items;
      _workspace = selected;
      _loading = false;
      if (selected == null)
        await _preferences.remove('bookworm:workspace:$actor');
      else
        await _preferences.setString('bookworm:workspace:$actor', selected.id);
      if (current()) _notify();
    } on ApiError catch (error) {
      if (current()) _clear(error.message);
    } on PlatformException {
      if (current())
        _clear('Workspace preferences could not be saved. Try again.');
    }
  }

  Future<void> selectWorkspace(Workspace workspace) async {
    final actor = user?.id;
    final matches = _workspaces.where((item) => item.id == workspace.id);
    if (_disposed || actor == null || actor != _ownerId || matches.isEmpty)
      return;
    ++_generation;
    if (_workspace?.id != workspace.id) ++_scopeRevision;
    _workspace = matches.first;
    _loading = false;
    _error = null;
    _notify();
    await _preferences.setString('bookworm:workspace:$actor', workspace.id);
  }

  Future<String?> createWorkspace(String name) => _guard(() async {
        final client = api;
        if (client == null)
          throw ApiError(401, 'session_changed', 'Sign in again.', '');
        await client.createWorkspace(name.trim());
        await refreshWorkspaces();
      });

  Future<String?> login(String email, String password) => _guard(() async {
        await _client.auth.signInWithPassword(email: email, password: password);
        await refreshWorkspaces();
      });
  Future<String?> signup(String email, String password, {String? name}) =>
      _guard(() async {
        await _client.auth.signUp(
            email: email,
            password: password,
            emailRedirectTo: mobileAuthRedirect,
            data: {
              if (name?.trim().isNotEmpty == true) 'full_name': name!.trim()
            });
        await refreshWorkspaces();
      });
  Future<String?> googleSignIn() => _guard(() async {
        final opened = await _client.auth.signInWithOAuth(OAuthProvider.google,
            redirectTo: mobileAuthRedirect,
            authScreenLaunchMode: LaunchMode.externalApplication);
        if (!opened)
          throw ApiError(503, 'browser_unavailable',
              'Could not open Google sign-in. Try again.', '');
      });
  Future<String?> resetPassword(String email) => _guard(() => _client.auth
      .resetPasswordForEmail(email, redirectTo: mobileAuthRedirect));
  Future<String?> updatePassword(String password) => _guard(() async {
        if (!_recoveringPassword)
          throw ApiError(
              403, 'recovery_required', 'Open a new password reset link.', '');
        await _client.auth.updateUser(UserAttributes(password: password));
        _recoveringPassword = false;
        await refreshWorkspaces();
      });

  Future<String?> _guard(Future<void> Function() action) async {
    try {
      await action();
      return null;
    } on ApiError catch (error) {
      return error.message;
    } on AuthException {
      return 'Sign-in could not be completed. Check your details or request a new reset link.';
    } on PlatformException {
      return 'Secure sign-in is unavailable on this device. Try again.';
    } on http.ClientException {
      return 'Check your connection and try again.';
    }
  }

  Future<void> signOut() async {
    _signingOut = true;
    _recoveringPassword = false;
    _ownerId = null;
    _clear();
    try {
      await _client.auth.signOut(scope: SignOutScope.local);
    } finally {
      _signingOut = false;
      await refreshWorkspaces();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    ++_generation;
    ++_scopeRevision;
    unawaited(_subscription?.cancel());
    super.dispose();
  }
}
