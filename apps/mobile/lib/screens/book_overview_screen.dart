import 'package:flutter/material.dart';

import '../auth.dart';
import '../models.dart';
import 'ai_assistant_screen.dart';
import 'assets_screen.dart';
import 'publishing_screen.dart';
import 'reader_screen.dart';

/// Book overview: chapter list + progress + quick actions. "Progress" is just
/// the share of non-draft chapters — status values come from the server, no
/// scoring rules live here.
class BookOverviewScreen extends StatefulWidget {
  const BookOverviewScreen({super.key, required this.auth, required this.book});
  final AuthState auth;
  final Book book;

  @override
  State<BookOverviewScreen> createState() => _BookOverviewScreenState();
}

class _BookOverviewScreenState extends State<BookOverviewScreen> {
  List<Chapter> _chapters = const [];
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = widget.auth.api;
    if (api == null) return;
    setState(() => _loading = true);
    try {
      final chapters = await api.listChapters(widget.book.id);
      if (mounted) {
        setState(() {
          _chapters = chapters;
          _loading = false;
          _error = null;
        });
      }
    } on Exception catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  void _open(Widget screen) => Navigator.of(context)
      .push(MaterialPageRoute(builder: (_) => screen));

  @override
  Widget build(BuildContext context) {
    final done = _chapters.where((c) => c.status != 'draft').length;
    final progress = _chapters.isEmpty ? 0.0 : done / _chapters.length;
    return Scaffold(
      appBar: AppBar(title: Text(widget.book.title)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(widget.book.authorName,
                style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            LinearProgressIndicator(value: progress),
            Text('${_chapters.length} chapters, $done past draft'),
            if (_error != null) Text(_error!),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              children: [
                ActionChip(
                  avatar: const Icon(Icons.auto_awesome, size: 18),
                  label: const Text('AI Assistant'),
                  onPressed: () => _open(
                      AiAssistantScreen(auth: widget.auth, book: widget.book)),
                ),
                ActionChip(
                  avatar: const Icon(Icons.folder_outlined, size: 18),
                  label: const Text('Assets'),
                  onPressed: () =>
                      _open(AssetsScreen(auth: widget.auth)),
                ),
                ActionChip(
                  avatar: const Icon(Icons.publish, size: 18),
                  label: const Text('Publishing'),
                  onPressed: () => _open(
                      PublishingScreen(auth: widget.auth, book: widget.book)),
                ),
              ],
            ),
            const Divider(height: 32),
            if (_loading) const Center(child: CircularProgressIndicator()),
            for (final c in _chapters)
              ListTile(
                title: Text(c.title),
                subtitle: Text('Chapter ${c.orderIndex + 1} • ${c.status}'),
                onTap: () => _open(ReaderScreen(
                  auth: widget.auth,
                  chapter: c,
                  workspaceId: widget.book.workspaceId,
                )),
              ),
          ],
        ),
      ),
    );
  }
}
