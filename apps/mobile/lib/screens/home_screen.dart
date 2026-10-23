import 'package:flutter/material.dart';

import '../auth.dart';
import '../models.dart';
import 'book_overview_screen.dart';
import 'assets_screen.dart';
import 'book_setup_screen.dart';

/// Home: recent books + open tasks for the selected workspace.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth});
  final AuthState auth;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<Book> _books = const [];
  List<TaskItem> _tasks = const [];
  String? _error;
  bool _loading = true;
  int _loadGeneration = 0;
  String? _savingTask;

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
    if (!mounted) return;
    final generation = ++_loadGeneration;
    final api = widget.auth.api;
    final ws = widget.auth.workspace;
    if (api == null || ws == null) {
      setState(() {
        _books = const [];
        _tasks = const [];
        _loading = false;
        _error = null;
      });
      return;
    }
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        api.listBooks(ws.id),
        api.listTasks(ws.id),
      ]);
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _books = results[0] as List<Book>;
        _tasks = (results[1] as List<TaskItem>)
            .where((t) => t.status != 'done' && t.status != 'cancelled')
            .toList();
        _loading = false;
        _error = null;
      });
    } on Exception catch (e) {
      if (mounted && generation == _loadGeneration)
        setState(() {
          _error = e is ApiError
              ? e.message
              : 'Your library could not be loaded. Refresh to try again.';
          _books = const [];
          _tasks = const [];
          _loading = false;
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ws = widget.auth.workspace;
    return Scaffold(
      appBar: AppBar(
          title: Text(ws == null ? 'Home' : 'Home — ${ws.name}'),
          actions: [
            IconButton(
                tooltip: 'Files & artwork',
                icon: const Icon(Icons.folder_outlined),
                onPressed: ws == null
                    ? null
                    : () => Navigator.of(context).push(MaterialPageRoute(
                        builder: (_) => AssetsScreen(auth: widget.auth)))),
          ]),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            if (_loading) const LinearProgressIndicator(),
            if (_error != null) Text(_error!),
            if (ws == null && !_loading)
              const Text('Choose or create a workspace to begin.'),
            if (ws != null) ...[
              FilledButton.icon(
                  onPressed: () async {
                    await Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => BookSetupScreen(auth: widget.auth)));
                    if (mounted) await _load();
                  },
                  icon: const Icon(Icons.add),
                  label: const Text('Create a book')),
              const SizedBox(height: 20),
            ],
            Text('Your books', style: Theme.of(context).textTheme.titleMedium),
            for (final b in _books)
              ListTile(
                title: Text(b.title),
                subtitle: Text('${b.authorName} • ${b.status}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) =>
                      BookOverviewScreen(auth: widget.auth, book: b),
                )),
              ),
            if (_books.isEmpty && !_loading)
              const ListTile(title: Text('No books yet')),
            const SizedBox(height: 16),
            Text('Open tasks', style: Theme.of(context).textTheme.titleMedium),
            for (final t in _tasks.take(10))
              ListTile(
                leading: const Icon(Icons.check_box_outlined),
                title: Text(t.title),
                subtitle: Text('${t.status} • ${t.priority}'),
                onTap: _savingTask != null
                    ? null
                    : () async {
                        setState(() => _savingTask = t.id);
                        try {
                          await widget.auth.api
                              ?.updateTask(t.id, status: 'done');
                          if (mounted) await _load();
                        } on Exception catch (error) {
                          if (mounted)
                            setState(() => _error = error is ApiError
                                ? error.message
                                : 'Task update is unconfirmed. Refresh before trying again.');
                        } finally {
                          if (mounted) setState(() => _savingTask = null);
                        }
                      },
              ),
            if (_tasks.isEmpty && !_loading)
              const ListTile(title: Text('No open tasks')),
          ],
        ),
      ),
    );
  }
}
