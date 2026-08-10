// Hand-written Dart models mirroring services/api/openapi.yaml schemas and the
// DB shapes (supabase/migrations) those endpoints return. No codegen deps on
// purpose — replace with a generated client from openapi.yaml when the API
// surface stabilizes (packages/api-client owns the TS equivalent).

Map<String, dynamic> _map(Map<String, dynamic> j, String k) =>
    (j[k] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};

class ApiError implements Exception {
  ApiError(this.status, this.code, this.message, this.requestId);

  factory ApiError.fromJson(int status, Map<String, dynamic> j) {
    final e = _map(j, 'error');
    return ApiError(
      status,
      e['code'] as String? ?? 'unknown',
      e['message'] as String? ?? 'request failed',
      e['requestId'] as String? ?? '',
    );
  }

  final int status;
  final String code;
  final String message;
  final String requestId;

  @override
  String toString() => '[$status] $code: $message';
}

class Workspace {
  Workspace(this.id, this.name, this.organizationId);
  factory Workspace.fromJson(Map<String, dynamic> j) => Workspace(
        j['id'] as String,
        j['name'] as String? ?? '',
        j['organization_id'] as String? ?? '',
      );
  final String id;
  final String name;
  final String organizationId;
}

class Book {
  Book({
    required this.id,
    required this.workspaceId,
    required this.title,
    required this.authorName,
    required this.status,
    this.subtitle,
    this.genre,
  });

  factory Book.fromJson(Map<String, dynamic> j) => Book(
        id: j['id'] as String,
        workspaceId: j['workspace_id'] as String? ?? '',
        title: j['title'] as String? ?? '',
        subtitle: j['subtitle'] as String?,
        authorName: j['author_name'] as String? ?? '',
        genre: j['genre'] as String?,
        status: j['status'] as String? ?? 'draft',
      );

  final String id;
  final String workspaceId;
  final String title;
  final String? subtitle;
  final String authorName;
  final String? genre;
  final String status;
}

class Chapter {
  Chapter({
    required this.id,
    required this.bookId,
    required this.orderIndex,
    required this.title,
    required this.status,
  });

  factory Chapter.fromJson(Map<String, dynamic> j) => Chapter(
        id: j['id'] as String,
        bookId: j['book_id'] as String? ?? '',
        orderIndex: (j['order_index'] as num?)?.toInt() ?? 0,
        title: j['title'] as String? ?? '',
        status: j['status'] as String? ?? 'draft',
      );

  final String id;
  final String bookId;
  final int orderIndex;
  final String title;
  final String status;
}

class AiJob {
  AiJob({
    required this.jobId,
    required this.agentType,
    required this.status,
    required this.suggestions,
    this.error,
  });

  // AI service returns camelCase job objects (services/ai/main.py).
  factory AiJob.fromJson(Map<String, dynamic> j) => AiJob(
        jobId: (j['jobId'] ?? j['id']) as String,
        agentType: j['agentType'] as String? ?? '',
        status: j['status'] as String? ?? 'queued',
        suggestions: [
          for (final s in (j['suggestions'] as List? ?? const []))
            AiSuggestion.fromJson((s as Map).cast<String, dynamic>()),
        ],
        error: j['error'] as String?,
      );

  final String jobId;
  final String agentType;
  final String status;
  final List<AiSuggestion> suggestions;
  final String? error;

  bool get isRunning => status == 'queued' || status == 'running';
}

class AiSuggestion {
  AiSuggestion({
    required this.id,
    required this.chapterId,
    required this.operation,
    required this.status,
    this.nodeId,
    this.rationale,
    this.confidence,
  });

  factory AiSuggestion.fromJson(Map<String, dynamic> j) => AiSuggestion(
        id: j['id'] as String,
        chapterId: j['chapterId'] as String? ?? '',
        nodeId: j['nodeId'] as String?,
        operation: _map(j, 'operation'),
        rationale: j['rationale'] as String?,
        confidence: (j['confidence'] as num?)?.toDouble(),
        status: j['status'] as String? ?? 'pending',
      );

  final String id;
  final String chapterId;
  final String? nodeId;
  final Map<String, dynamic> operation;
  final String? rationale;
  final double? confidence;
  String status;
}

class Community {
  Community(this.id, this.name, this.slug, this.visibility, {this.description});

  factory Community.fromJson(Map<String, dynamic> j) => Community(
        j['id'] as String,
        j['name'] as String? ?? '',
        j['slug'] as String? ?? '',
        j['visibility'] as String? ?? 'public',
        description: j['description'] as String?,
      );

  final String id;
  final String name;
  final String slug;
  final String visibility;
  final String? description;
}

class CommunityPost {
  CommunityPost({
    required this.id,
    required this.communityId,
    required this.body,
    required this.createdAt,
    this.title,
  });

  factory CommunityPost.fromJson(Map<String, dynamic> j) => CommunityPost(
        id: j['id'] as String,
        communityId: j['community_id'] as String? ?? '',
        title: j['title'] as String?,
        body: j['body'] as String? ?? '',
        createdAt: DateTime.tryParse(j['created_at'] as String? ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0),
      );

  final String id;
  final String communityId;
  final String? title;
  final String body;
  final DateTime createdAt;
}

class TaskItem {
  TaskItem({
    required this.id,
    required this.title,
    required this.status,
    required this.priority,
    this.description,
    this.dueAt,
  });

  factory TaskItem.fromJson(Map<String, dynamic> j) => TaskItem(
        id: j['id'] as String,
        title: j['title'] as String? ?? '',
        description: j['description'] as String?,
        status: j['status'] as String? ?? 'todo',
        priority: j['priority'] as String? ?? 'medium',
        dueAt: j['due_at'] == null
            ? null
            : DateTime.tryParse(j['due_at'] as String),
      );

  static const statuses = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];

  final String id;
  final String title;
  final String? description;
  String status;
  final String priority;
  final DateTime? dueAt;
}

class AssetItem {
  AssetItem({
    required this.id,
    required this.name,
    required this.type,
    required this.mimeType,
    required this.sizeBytes,
    required this.status,
  });

  factory AssetItem.fromJson(Map<String, dynamic> j) => AssetItem(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        type: j['type'] as String? ?? '',
        mimeType: j['mime_type'] as String? ?? '',
        sizeBytes: (j['size_bytes'] as num?)?.toInt() ?? 0,
        status: j['status'] as String? ?? 'draft',
      );

  final String id;
  final String name;
  final String type;
  final String mimeType;
  final int sizeBytes;
  final String status;
}

class PublishingJob {
  PublishingJob({
    required this.id,
    required this.bookId,
    required this.channel,
    required this.status,
    required this.createdAt,
  });

  factory PublishingJob.fromJson(Map<String, dynamic> j) => PublishingJob(
        id: j['id'] as String,
        bookId: j['book_id'] as String? ?? '',
        channel: j['channel'] as String? ?? '',
        status: j['status'] as String? ?? 'queued',
        createdAt: DateTime.tryParse(j['created_at'] as String? ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0),
      );

  final String id;
  final String bookId;
  final String channel;
  final String status;
  final DateTime createdAt;
}

class UsageInfo {
  UsageInfo(this.entitlements, this.usage, this.creditBalance);

  factory UsageInfo.fromJson(Map<String, dynamic> j) => UsageInfo(
        _map(j, 'entitlements'),
        {
          for (final e in _map(j, 'usage').entries)
            e.key: (e.value as num?)?.toDouble() ?? 0,
        },
        (j['creditBalance'] as num?)?.toInt() ??
            (j['credit_balance'] as num?)?.toInt() ??
            0,
      );

  final Map<String, dynamic> entitlements;
  final Map<String, double> usage;
  final int creditBalance;
}
