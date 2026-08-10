import 'package:flutter/material.dart';

import '../auth.dart';
import '../models.dart';
import 'book_overview_screen.dart';

class BooksScreen extends StatefulWidget {
  const BooksScreen({super.key, required this.auth});
  final AuthState auth;

  @override
  State<BooksScreen> createState() => _BooksScreenState();
}

class _BooksScreenState extends State<BooksScreen> {
  List<Book> _books = const [];
  String _filter = '';
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    widget.auth.addListener(_load);
    _load();
  }

  @override
  void dispose() {
    widget.auth.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    final api = widget.auth.api;
    final ws = widget.auth.workspace;
    if (api == null || ws == null) {
      if (mounted) {
        setState(() {
          _books = const [];
          _loading = false;
        });
      }
      return;
    }
    setState(() => _loading = true);
    try {
      final books = await api.listBooks(ws.id);
      if (mounted) {
        setState(() {
          _books = books;
          _loading = false;
          _error = null;
        });
      }
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final shown = _books
        .where((b) =>
            _filter.isEmpty ||
            b.title.toLowerCase().contains(_filter) ||
            b.authorName.toLowerCase().contains(_filter))
        .toList();
    return Scaffold(
      appBar: AppBar(title: const Text('Books')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Filter by title or author',
              ),
              onChanged: (v) => setState(() => _filter = v.toLowerCase()),
            ),
          ),
          if (_error != null) Text(_error!),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: ListView.builder(
                itemCount: shown.length,
                itemBuilder: (_, i) {
                  final b = shown[i];
                  return ListTile(
                    title: Text(b.title),
                    subtitle: Text(
                        '${b.authorName}${b.genre != null ? ' • ${b.genre}' : ''} • ${b.status}'),
                    onTap: () =>
                        Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) =>
                          BookOverviewScreen(auth: widget.auth, book: b),
                    )),
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}
