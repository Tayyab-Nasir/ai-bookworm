import 'package:flutter/material.dart';

import '../auth.dart';
import '../models.dart';

class TasksScreen extends StatefulWidget {
  const TasksScreen({super.key, required this.auth});
  final AuthState auth;

  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends State<TasksScreen> {
  List<TaskItem> _tasks = const [];
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
      if (mounted) setState(() => _loading = false);
      return;
    }
    setState(() => _loading = true);
    try {
      final tasks = await api.listTasks(ws.id);
      if (mounted) {
        setState(() {
          _tasks = tasks;
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

  Future<void> _add() async {
    final controller = TextEditingController();
    final title = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New task'),
        content: TextField(
            controller: controller,
            autofocus: true,
            decoration: const InputDecoration(hintText: 'Title')),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, controller.text.trim()),
              child: const Text('Create')),
        ],
      ),
    );
    final ws = widget.auth.workspace;
    if (title == null || title.isEmpty || ws == null) return;
    await widget.auth.api?.createTask(ws.id, title);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tasks')),
      floatingActionButton: FloatingActionButton(
        onPressed: _add,
        child: const Icon(Icons.add),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          children: [
            if (_error != null) Text(_error!),
            if (_loading) const LinearProgressIndicator(),
            for (final t in _tasks)
              ListTile(
                leading: Icon(t.status == 'done'
                    ? Icons.check_box
                    : Icons.check_box_outline_blank),
                title: Text(t.title),
                subtitle: Text(
                    '${t.priority}${t.dueAt != null ? ' • due ${t.dueAt!.toLocal().toString().substring(0, 10)}' : ''}'),
                trailing: DropdownButton<String>(
                  value: t.status,
                  underline: const SizedBox.shrink(),
                  items: [
                    for (final s in TaskItem.statuses)
                      DropdownMenuItem(value: s, child: Text(s)),
                  ],
                  onChanged: (s) async {
                    if (s == null) return;
                    await widget.auth.api?.updateTask(t.id, status: s);
                    await _load();
                  },
                ),
              ),
            if (_tasks.isEmpty && !_loading)
              const ListTile(title: Text('No tasks')),
          ],
        ),
      ),
    );
  }
}
