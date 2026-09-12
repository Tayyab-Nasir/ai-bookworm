import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:crypto/crypto.dart';

/// API client for AI Bookworm mobile app
class ApiClient {
  final String baseUrl;
  final http.Client _client;
  String? _accessToken;

  ApiClient({required this.baseUrl, http.Client? client})
      : _client = client ?? http.Client();

  /// Initialize with stored token
  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _accessToken = prefs.getString('access_token');
  }

  /// Set access token
  Future<void> setAccessToken(String? token) async {
    _accessToken = token;
    final prefs = await SharedPreferences.getInstance();
    if (token != null) {
      await prefs.setString('access_token', token);
    } else {
      await prefs.remove('access_token');
    }
  }

  /// Get headers with auth
  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_accessToken != null) 'Authorization': 'Bearer $_accessToken',
      };

  /// Generic GET request
  Future<T> get<T>(String path, T Function(Map<String, dynamic>) parser) async {
    final response = await _client.get(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
    );
    _checkResponse(response);
    return parser(jsonDecode(response.body) as Map<String, dynamic>);
  }

  /// Generic POST request
  Future<T> post<T>(String path, Object? body, T Function(Map<String, dynamic>) parser) async {
    final response = await _client.post(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
      body: body != null ? jsonEncode(body) : null,
    );
    _checkResponse(response);
    return parser(jsonDecode(response.body) as Map<String, dynamic>);
  }

  /// Generic DELETE request
  Future<T> delete<T>(String path, T Function(Map<String, dynamic>) parser) async {
    final response = await _client.delete(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
    );
    _checkResponse(response);
    return parser(jsonDecode(response.body) as Map<String, dynamic>);
  }

  void _checkResponse(http.Response response) {
    if (response.statusCode >= 400) {
      throw ApiException(response.statusCode, response.body);
    }
  }

  /// Auth endpoints
  Future<AuthResult> signup({
    required String email,
    required String password,
    required String name,
    String? ref,
  }) async {
    return post('/api/auth/signup', {
      'email': email,
      'password': password,
      'name': name,
      if (ref != null) 'ref': ref,
    }, (json) => AuthResult.fromJson(json));
  }

  Future<AuthResult> login({
    required String email,
    required String password,
  }) async {
    return post('/api/auth/login', {
      'email': email,
      'password': password,
    }, (json) => AuthResult.fromJson(json));
  }

  Future<void> logout() async {
    await post('/api/auth/logout', null, (json) => null);
    await setAccessToken(null);
  }

  Future<User?> getSession() async {
    try {
      return get('/api/auth/session', (json) => User.fromJson(json['user']));
    } on ApiException catch (e) {
      if (e.statusCode == 401) return null;
      rethrow;
    }
  }

  /// Account endpoints
  Future<DataRequestsResponse> listDataRequests() async {
    return get('/v1/account/data-requests', (json) => DataRequestsResponse.fromJson(json));
  }

  Future<DataRequestResult> createDataRequest({
    required String type,
    String? reason,
    String? confirmation,
  }) async {
    return post('/v1/account/data-requests', {
      'type': type,
      if (reason != null) 'reason': reason,
      if (confirmation != null) 'confirmation': confirmation,
    }, (json) => DataRequestResult.fromJson(json));
  }

  Future<void> cancelDataRequest(String requestId) async {
    await delete('/v1/account/data-requests/$requestId', (json) => null);
  }

  Future<SupportTicketsResponse> listSupportTickets() async {
    return get('/v1/account/support/tickets', (json) => SupportTicketsResponse.fromJson(json));
  }

  Future<SupportTicketResult> createSupportTicket({
    required String category,
    required String subject,
    required String body,
  }) async {
    return post('/v1/account/support/tickets', {
      'category': category,
      'subject': subject,
      'body': body,
    }, (json) => SupportTicketResult.fromJson(json));
  }
}

/// API exception
class ApiException implements Exception {
  final int statusCode;
  final String body;

  ApiException(this.statusCode, this.body);

  @override
  String toString() => 'ApiException: $statusCode - $body';
}

/// Auth models
class AuthResult {
  final User? user;
  final String? redirectTo;
  final bool confirmationRequired;
  final String? message;

  AuthResult({this.user, this.redirectTo, this.confirmationRequired, this.message});

  factory AuthResult.fromJson(Map<String, dynamic> json) => AuthResult(
        user: json['user'] != null ? User.fromJson(json['user']) : null,
        redirectTo: json['redirectTo'],
        confirmationRequired: json['confirmationRequired'] ?? false,
        message: json['message'],
      );
}

class User {
  final String id;
  final String email;
  final String? displayName;
  final String? avatarUrl;

  User({required this.id, required this.email, this.displayName, this.avatarUrl});

  factory User.fromJson(Map<String, dynamic> json) => User(
        id: json['id'],
        email: json['email'],
        displayName: json['display_name'],
        avatarUrl: json['avatar_url'],
      );
}

/// Data requests models
class DataRequestsResponse {
  final List<DataRequest> requests;

  DataRequestsResponse({required this.requests});

  factory DataRequestsResponse.fromJson(Map<String, dynamic> json) => DataRequestsResponse(
        requests: (json['requests'] as List)
            .map((e) => DataRequest.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class DataRequest {
  final String id;
  final String requestType;
  final String status;
  final String? reason;
  final String requestedAt;
  final String dueAt;
  final String? completedAt;

  DataRequest({
    required this.id,
    required this.requestType,
    required this.status,
    this.reason,
    required this.requestedAt,
    required this.dueAt,
    this.completedAt,
  });

  factory DataRequest.fromJson(Map<String, dynamic> json) => DataRequest(
        id: json['id'],
        requestType: json['request_type'],
        status: json['status'],
        reason: json['reason'],
        requestedAt: json['requested_at'],
        dueAt: json['due_at'],
        completedAt: json['completed_at'],
      );
}

class DataRequestResult {
  final DataRequest request;

  DataRequestResult({required this.request});

  factory DataRequestResult.fromJson(Map<String, dynamic> json) => DataRequestResult(
        request: DataRequest.fromJson(json['request']),
      );
}

/// Support tickets models
class SupportTicketsResponse {
  final List<SupportTicket> tickets;

  SupportTicketsResponse({required this.tickets});

  factory SupportTicketsResponse.fromJson(Map<String, dynamic> json) => SupportTicketsResponse(
        tickets: (json['tickets'] as List)
            .map((e) => SupportTicket.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class SupportTicket {
  final String id;
  final String category;
  final String subject;
  final String status;
  final String priority;
  final String createdAt;

  SupportTicket({
    required this.id,
    required this.category,
    required this.subject,
    required this.status,
    required this.priority,
    required this.createdAt,
  });

  factory SupportTicket.fromJson(Map<String, dynamic> json) => SupportTicket(
        id: json['id'],
        category: json['category'],
        subject: json['subject'],
        status: json['status'],
        priority: json['priority'],
        createdAt: json['created_at'],
      );
}

class SupportTicketResult {
  final SupportTicket ticket;

  SupportTicketResult({required this.ticket});

  factory SupportTicketResult.fromJson(Map<String, dynamic> json) => SupportTicketResult(
        ticket: SupportTicket.fromJson(json['ticket']),
      );
}