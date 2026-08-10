import 'dart:async';

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../auth.dart';
import '../models.dart';

/// Review-first AI screen: run a job, poll until done, then apply or reject
/// each suggestion. Apply = AI service validates + returns the operation, then
/// we submit it to the document API with the chapter's current version.
/// Reject stays local until a /reject endpoint lands (suggestions are pending
/// server-side until applied).
class AiAssistantScreen extends StatefulWidget {
  const AiAssistantScreen({super.key, required this.auth, this.book});
  final AuthState auth;
  final Book? book;

  @override
  State<AiAssistantScreen> createState() => _AiAssistantScreenState();
}

class _AiAssistantScreenState extends State<AiAssistantScreen> {
  static const _agents = ['proofreader', 'copyeditor'];

  List<Book> _books = const [];
  List<Chapter> _chapters = const [];
  Book? _book;
  Chapter? _chapter;
  String _agent = _agents.first;
  AiJob? _job;
  Timer? _poll;
  bool _busy = false;
  String? _error;
  final Set<String> _rejected = {};

  @override
  void initState() {
    super.initState();
    _book = widget.book;
    _loadBooks();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _loadBooks() async {
    final api = widget.auth.api;
    final ws = widget.auth.workspace;
    if (api == null || ws == null) return;
    try {
      final books = await api.listBooks(ws.id);
      if (!mounted) return;
      setState(() {
        _books = books;
        _book ??= books.isEmpty ? null : books.first;
      });
      await _loadChapters();
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _loadChapters() async {
    final api = widget.auth.api;
    final book = _book;
    if (api == null || book == null) return;
    final chapters = await api.listChapters(book.id);
    if (!mounted) return;
    setState(() {
      _chapters = chapters;
      _chapter = chapters.isEmpty ? null : chapters.first;
    });
  }

  Future<void> _run() async {
    final api = widget.auth.api;
    final ws = widget.auth.workspace;
    final book = _book;
    final chapter = _chapter;
    if (api == null || ws == null || book == null || chapter == null) return;
    setState(() {
      _busy = true;
      _error = null;
      _job = null;
      _rejected.clear();
    });
    try {
      // Inline chapter content until the AI service is wired to Postgres
      // (services/ai AgentInput.chapters).
      final rows = await Supabase.instance.client
          .from('document_versions')
          .select('version_number, content_json')
          .eq('chapter_id', chapter.id)
          .order('version_number', ascending: false)
          .limit(1);
      final content = rows.isEmpty
          ? const <String, dynamic>{}
          : (rows.first['content_json'] as Map).cast<String, dynamic>();
      final job = await api.createAiJob(
        widget.auth.aiBaseUrl,
        workspaceId: ws.id,
        bookId: book.id,
        agentType: _agent,
        idempotencyKey:
            'mobile-$_agent-${chapter.id}-${DateTime.now().microsecondsSinceEpoch}',
        input: {
          'chapterIds': [chapter.id],
          'chapters': {chapter.id: content},
        },
      );
      if (!mounted) return;
      setState(() => _job = job);
      _poll?.cancel();
      _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refreshJob());
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshJob() async {
    final api = widget.auth.api;
    final job = _job;
    if (api == null || job == null) return;
    try {
      final fresh = await api.getAiJob(widget.auth.aiBaseUrl, job.jobId);
      if (!mounted) return;
      setState(() => _job = fresh);
      if (!fresh.isRunning) _poll?.cancel();
    } on Exception {
      // Transient poll failure — next tick retries.
    }
  }

  Future<void> _apply(AiSuggestion s) async {
    final api = widget.auth.api;
    if (api == null) return;
    try {
      final op = await api.applyAiSuggestion(widget.auth.aiBaseUrl, s.id);
      final rows = await Supabase.instance.client
          .from('document_versions')
          .select('version_number')
          .eq('chapter_id', s.chapterId)
          .order('version_number', ascending: false)
          .limit(1);
      final version =
          rows.isEmpty ? 0 : (rows.first['version_number'] as num).toInt();
      await api.applyChapterOperation(
        s.chapterId,
        operationId: op['operationId'] as String? ??
            'ai-${s.id}-${DateTime.now().microsecondsSinceEpoch}',
        type: op['type'] as String? ?? 'replace_text',
        target: (op['target'] as Map?)?.cast<String, dynamic>() ??
            {'chapterId': s.chapterId, if (s.nodeId != null) 'nodeId': s.nodeId},
        payload: (op['payload'] as Map?)?.cast<String, dynamic>() ?? const {},
        expectedVersion: version,
        source: 'ai',
        sourceRef: s.id,
      );
      if (mounted) setState(() => s.status = 'accepted');
    } on Exception catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString())));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final job = _job;
    return Scaffold(
      appBar: AppBar(title: const Text('AI Assistant')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (_error != null) Text(_error!),
          DropdownButtonFormField<Book>(
            value: _book,
            decoration: const InputDecoration(labelText: 'Book'),
            items: [
              for (final b in _books)
                DropdownMenuItem(value: b, child: Text(b.title)),
            ],
            onChanged: (b) {
              setState(() => _book = b);
              _loadChapters();
            },
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<Chapter>(
            value: _chapter,
            decoration: const InputDecoration(labelText: 'Chapter'),
            items: [
              for (final c in _chapters)
                DropdownMenuItem(value: c, child: Text(c.title)),
            ],
            onChanged: (c) => setState(() => _chapter = c),
          ),
          const SizedBox(height: 8),
          SegmentedButton<String>(
            segments: [
              for (final a in _agents)
                ButtonSegment(value: a, label: Text(a)),
            ],
            selected: {_agent},
            onSelectionChanged: (s) => setState(() => _agent = s.first),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _busy || _chapter == null ? null : _run,
            icon: const Icon(Icons.auto_awesome),
            label: Text(_busy ? 'Running…' : 'Run $_agent'),
          ),
          if (job != null) ...[
            const Divider(height: 32),
            Text('Job ${job.jobId} — ${job.status}'),
            if (job.isRunning) const LinearProgressIndicator(),
            if (job.suggestions.isEmpty && !job.isRunning)
              const Text('No suggestions.'),
            for (final s in job.suggestions)
              if (!_rejected.contains(s.id))
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(s.rationale ?? 'Edit suggestion',
                            style:
                                Theme.of(context).textTheme.titleSmall),
                        if (s.confidence != null)
                          Text(
                              'confidence ${(s.confidence! * 100).toStringAsFixed(0)}%'),
                        Text(s.operation.toString(),
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodySmall),
                        const SizedBox(height: 8),
                        if (s.status == 'pending')
                          Row(
                            children: [
                              FilledButton.tonal(
                                onPressed: () => _apply(s),
                                child: const Text('Apply'),
                              ),
                              const SizedBox(width: 8),
                              TextButton(
                                onPressed: () => setState(
                                    () => _rejected.add(s.id)),
                                child: const Text('Reject'),
                              ),
                            ],
                          )
                        else
                          Text('status: ${s.status}'),
                      ],
                    ),
                  ),
                ),
          ],
        ],
      ),
    );
  }
}
