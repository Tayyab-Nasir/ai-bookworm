import 'package:flutter/material.dart';

import '../auth.dart';
import '../models.dart';

class CommunityScreen extends StatefulWidget {
  const CommunityScreen({super.key, required this.auth});
  final AuthState auth;

  @override
  State<CommunityScreen> createState() => _CommunityScreenState();
}

class _CommunityScreenState extends State<CommunityScreen> {
  List<Community> _communities = const [];
  Community? _community;
  List<CommunityPost> _posts = const [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = widget.auth.api;
    if (api == null) return;
    try {
      final communities = await api.listCommunities();
      if (!mounted) return;
      setState(() {
        _communities = communities;
        _community ??= communities.isEmpty ? null : communities.first;
        _error = null;
      });
      await _loadPosts();
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _loadPosts() async {
    final api = widget.auth.api;
    final c = _community;
    if (api == null || c == null) {
      setState(() => _posts = const []);
      return;
    }
    try {
      final posts = await api.listCommunityPosts(c.id);
      if (mounted) setState(() => _posts = posts);
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _newPost() async {
    final title = TextEditingController();
    final body = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New post'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
                controller: title,
                decoration: const InputDecoration(hintText: 'Title')),
            TextField(
                controller: body,
                maxLines: 4,
                decoration: const InputDecoration(hintText: 'Body')),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Post')),
        ],
      ),
    );
    final c = _community;
    if (ok != true || body.text.trim().isEmpty || c == null) return;
    await widget.auth.api
        ?.createCommunityPost(c.id, title: title.text.trim(), body: body.text.trim());
    await _loadPosts();
  }

  Future<void> _openPost(CommunityPost post) async {
    final api = widget.auth.api;
    if (api == null) return;
    final comments = await api.listPostComments(post.id);
    if (!mounted) return;
    final controller = TextEditingController();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
            bottom: MediaQuery.of(ctx).viewInsets.bottom, left: 16, right: 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 12),
            Text(post.title ?? 'Post',
                style: Theme.of(ctx).textTheme.titleMedium),
            Text(post.body),
            const Divider(),
            for (final c in comments)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Text('• ${c['body'] ?? ''}'),
              ),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: controller,
                    decoration:
                        const InputDecoration(hintText: 'Add a comment…'),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.send),
                  onPressed: () async {
                    final text = controller.text.trim();
                    if (text.isEmpty) return;
                    await api.createPostComment(post.id, text);
                    if (ctx.mounted) Navigator.pop(ctx);
                  },
                ),
              ],
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Community')),
      floatingActionButton: _community == null
          ? null
          : FloatingActionButton(
              onPressed: _newPost, child: const Icon(Icons.add)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: [
            if (_error != null) Text(_error!),
            if (_communities.isNotEmpty)
              DropdownButtonFormField<Community>(
                value: _community,
                decoration: const InputDecoration(labelText: 'Community'),
                items: [
                  for (final c in _communities)
                    DropdownMenuItem(value: c, child: Text(c.name)),
                ],
                onChanged: (c) {
                  setState(() => _community = c);
                  _loadPosts();
                },
              )
            else
              const Text('No communities available'),
            const SizedBox(height: 8),
            for (final p in _posts)
              Card(
                child: ListTile(
                  title: Text(p.title ?? p.body,
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text(p.body,
                      maxLines: 2, overflow: TextOverflow.ellipsis),
                  onTap: () => _openPost(p),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
