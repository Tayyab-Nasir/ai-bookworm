import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'api.dart';
import 'models.dart';

/// Supabase auth wrapper: login/signup/reset, session persistence (handled by
/// supabase_flutter storage), auth state as a single ChangeNotifier.
class AuthState extends ChangeNotifier {
  AuthState._(this._apiBaseUrl, this._aiBaseUrl);

  static Future<AuthState> init({
    required String supabaseUrl,
    required String supabaseAnonKey,
    required String apiBaseUrl,
    required String aiBaseUrl,
  }) async {
    await Supabase.initialize(url: supabaseUrl, anonKey: supabaseAnonKey);
    final s = AuthState._(apiBaseUrl, aiBaseUrl);
    Supabase.instance.client.auth.onAuthStateChange.listen((_) => s._refresh());
    await s._restoreWorkspace();
    await s._refresh();
    return s;
  }

  final String _apiBaseUrl;
  final String _aiBaseUrl;

  Workspace? _workspace;
  List<Workspace> _workspaces = const [];

  User? get user => Supabase.instance.client.auth.currentUser;
  bool get signedIn => user != null;
  Workspace? get workspace => _workspace;
  List<Workspace> get workspaces => _workspaces;
  String get aiBaseUrl => _aiBaseUrl;

  ApiClient? get api {
    final token = Supabase.instance.client.auth.currentSession?.accessToken;
    if (token == null) return null;
    return ApiClient(baseUrl: _apiBaseUrl, token: token);
  }

  Future<void> _restoreWorkspace() async {
    final prefs = await SharedPreferences.getInstance();
    final id = prefs.getString('workspaceId');
    if (id == null) return;
    _workspace = Workspace(id, prefs.getString('workspaceName') ?? '',
        prefs.getString('workspaceOrgId') ?? '');
  }

  Future<void> _refresh() async {
    final client = api;
    if (client != null) {
      try {
        _workspaces = await client.listWorkspaces();
        if (_workspaces.isNotEmpty &&
            !_workspaces.any((w) => w.id == _workspace?.id)) {
          await selectWorkspace(_workspaces.first);
          return; // selectWorkspace notifies
        }
      } on ApiError {
        // Keep last-known workspace; next refresh retries.
      }
    } else {
      _workspaces = const [];
      _workspace = null;
    }
    notifyListeners();
  }

  Future<void> selectWorkspace(Workspace w) async {
    _workspace = w;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('workspaceId', w.id);
    await prefs.setString('workspaceName', w.name);
    await prefs.setString('workspaceOrgId', w.organizationId);
    notifyListeners();
  }

  Future<String?> login(String email, String password) => _guard(() =>
      Supabase.instance.client.auth
          .signInWithPassword(email: email, password: password));

  Future<String?> signup(String email, String password) => _guard(() =>
      Supabase.instance.client.auth.signUp(email: email, password: password));

  Future<String?> resetPassword(String email) =>
      _guard(() => Supabase.instance.client.auth.resetPasswordForEmail(email));

  Future<String?> _guard(Future<dynamic> Function() fn) async {
    try {
      await fn();
      await _refresh();
      return null;
    } on AuthException catch (e) {
      return e.message;
    }
  }

  Future<void> signOut() async {
    await Supabase.instance.client.auth.signOut();
    await _refresh();
  }
}
