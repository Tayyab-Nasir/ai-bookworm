import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_client.dart';

/// Auth state
class AuthState {
  final bool isLoading;
  final String? error;
  final String? userId;
  final String? email;
  final String? displayName;

  const AuthState({
    this.isLoading = false,
    this.error,
    this.userId,
    this.email,
    this.displayName,
  });

  AuthState copyWith({
    bool? isLoading,
    String? error,
    String? userId,
    String? email,
    String? displayName,
  }) {
    return AuthState(
      isLoading: isLoading ?? this.isLoading,
      error: error ?? this.error,
      userId: userId ?? this.userId,
      email: email ?? this.email,
      displayName: displayName ?? this.displayName,
    );
  }

  bool get isAuthenticated => userId != null;
}

/// Auth notifier
class AuthNotifier extends StateNotifier<AuthState> {
  final ApiClient _apiClient;

  AuthNotifier(this._apiClient) : super(const AuthState()) {
    _checkSession();
  }

  Future<void> _checkSession() async {
    state = state.copyWith(isLoading: true);
    try {
      final user = await _apiClient.getSession();
      if (user != null) {
        state = state.copyWith(
          isLoading: false,
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
        );
      } else {
        state = state.copyWith(isLoading: false);
      }
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  Future<void> signup({
    required String email,
    required String password,
    required String name,
    String? ref,
  }) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final result = await _apiClient.signup(
        email: email,
        password: password,
        name: name,
        ref: ref,
      );
      if (result.confirmationRequired) {
        state = state.copyWith(
          isLoading: false,
          error: result.message ?? 'Please check your email to confirm your account.',
        );
      } else if (result.user != null) {
        state = state.copyWith(
          isLoading: false,
          userId: result.user!.id,
          email: result.user!.email,
          displayName: result.user!.displayName,
        );
      }
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  Future<void> login({
    required String email,
    required String password,
  }) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final result = await _apiClient.login(
        email: email,
        password: password,
      );
      if (result.user != null) {
        state = state.copyWith(
          isLoading: false,
          userId: result.user!.id,
          email: result.user!.email,
          displayName: result.user!.displayName,
        );
      }
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  Future<void> logout() async {
    state = state.copyWith(isLoading: true);
    try {
      await _apiClient.logout();
      state = const AuthState();
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }
}

/// Provider for API client
final apiClientProvider = Provider<ApiClient>((ref) {
  final client = ApiClient(baseUrl: 'http://localhost:3000');
  return client;
});

/// Provider for auth state
final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return AuthNotifier(apiClient);
});

/// Data requests state
class DataRequestsState {
  final bool isLoading;
  final String? error;
  final List<DataRequest> requests;

  const DataRequestsState({
    this.isLoading = false,
    this.error,
    this.requests = const [],
  });

  DataRequestsState copyWith({
    bool? isLoading,
    String? error,
    List<DataRequest>? requests,
  }) {
    return DataRequestsState(
      isLoading: isLoading ?? this.isLoading,
      error: error ?? this.error,
      requests: requests ?? this.requests,
    );
  }
}

class DataRequestsNotifier extends StateNotifier<DataRequestsState> {
  final ApiClient _apiClient;

  DataRequestsNotifier(this._apiClient) : super(const DataRequestsState()) {
    load();
  }

  Future<void> load() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final response = await _apiClient.listDataRequests();
      state = state.copyWith(isLoading: false, requests: response.requests);
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  Future<void> createExportRequest(String reason) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      await _apiClient.createDataRequest(type: 'export', reason: reason);
      await load();
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  Future<void> createDeleteRequest(String reason) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      await _apiClient.createDataRequest(
        type: 'delete',
        reason: reason,
        confirmation: 'DELETE MY ACCOUNT',
      );
      await load();
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  Future<void> cancelRequest(String requestId) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      await _apiClient.cancelDataRequest(requestId);
      await load();
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }
}

final dataRequestsProvider = StateNotifierProvider<DataRequestsNotifier, DataRequestsState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return DataRequestsNotifier(apiClient);
});

/// Support tickets state
class SupportTicketsState {
  final bool isLoading;
  final String? error;
  final List<SupportTicket> tickets;

  const SupportTicketsState({
    this.isLoading = false,
    this.error,
    this.tickets = const [],
  });

  SupportTicketsState copyWith({
    bool? isLoading,
    String? error,
    List<SupportTicket>? tickets,
  }) {
    return SupportTicketsState(
      isLoading: isLoading ?? this.isLoading,
      error: error ?? this.error,
      tickets: tickets ?? this.tickets,
    );
  }
}

class SupportTicketsNotifier extends StateNotifier<SupportTicketsState> {
  final ApiClient _apiClient;

  SupportTicketsNotifier(this._apiClient) : super(const SupportTicketsState()) {
    load();
  }

  Future<void> load() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final response = await _apiClient.listSupportTickets();
      state = state.copyWith(isLoading: false, tickets: response.tickets);
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  Future<void> createTicket({
    required String category,
    required String subject,
    required String body,
  }) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      await _apiClient.createSupportTicket(
        category: category,
        subject: subject,
        body: body,
      );
      await load();
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }
}

final supportTicketsProvider = StateNotifierProvider<SupportTicketsNotifier, SupportTicketsState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return SupportTicketsNotifier(apiClient);
});