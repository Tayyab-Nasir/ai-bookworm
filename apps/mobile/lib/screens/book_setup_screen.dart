import 'package:flutter/material.dart';

import '../auth.dart';
import '../book_workflow.dart';
import 'book_action_status.dart';
import 'book_overview_screen.dart';

class BookSetupScreen extends StatefulWidget {
  const BookSetupScreen({super.key, required this.auth});
  final AuthState auth;
  @override
  State<BookSetupScreen> createState() => _BookSetupScreenState();
}

class _BookSetupScreenState extends State<BookSetupScreen> {
  NativeBookWorkflow? _workflow;
  final _fields = {
    'title': TextEditingController(),
    'authorName': TextEditingController(),
    'language': TextEditingController(text: 'en'),
    'subtitle': TextEditingController(),
    'genre': TextEditingController(),
  };
  static const _labels = {
    'title': 'Book title',
    'authorName': 'Author or pen name',
    'language': 'Language code',
    'subtitle': 'Subtitle (optional)',
    'genre': 'Genre (optional)'
  };

  @override
  void initState() {
    super.initState();
    final api = widget.auth.api,
        workspace = widget.auth.workspace,
        user = widget.auth.user;
    if (api != null && workspace != null && user != null) {
      _workflow = NativeBookWorkflow(
          api: api, userId: user.id, workspaceId: workspace.id);
      _workflow!.refresh();
    }
  }

  @override
  void dispose() {
    _workflow?.dispose();
    for (final field in _fields.values) {
      field.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final workflow = _workflow;
    return Scaffold(
      appBar: AppBar(title: const Text('Create your book')),
      body: workflow == null
          ? const Center(
              child: Text('Choose a workspace before creating a book.'))
          : ListenableBuilder(
              listenable: workflow,
              builder: (context, _) => SafeArea(
                      child: ListView(
                          padding: const EdgeInsets.all(20),
                          children: [
                        Text('A home for your manuscript',
                            style: Theme.of(context).textTheme.headlineSmall),
                        const SizedBox(height: 8),
                        const Text(
                            'Start with a private book. Next, write chapters or import a screened manuscript. Creating a blank book does not generate AI content or spend credits.'),
                        const SizedBox(height: 20),
                        if (workflow.book == null &&
                            workflow.pendingKind == null)
                          for (final entry in _fields.entries)
                            Padding(
                                padding: const EdgeInsets.only(bottom: 16),
                                child: TextField(
                                  controller: entry.value,
                                  enabled: workflow.canStart,
                                  textCapitalization: entry.key == 'language'
                                      ? TextCapitalization.none
                                      : TextCapitalization.sentences,
                                  decoration: InputDecoration(
                                      labelText: _labels[entry.key],
                                      helperText: entry.key == 'language'
                                          ? 'For example: en, es, ur or ar'
                                          : null),
                                  maxLength: entry.key == 'authorName'
                                      ? 300
                                      : entry.key == 'language'
                                          ? 40
                                          : entry.key == 'genre'
                                              ? 200
                                              : 500,
                                )),
                        if (workflow.book == null &&
                            workflow.pendingKind == null)
                          FilledButton.icon(
                              onPressed: workflow.canStart
                                  ? () => workflow.create({
                                        for (final entry in _fields.entries)
                                          entry.key: entry.value.text
                                      })
                                  : null,
                              icon: const Icon(Icons.book_outlined),
                              label: const Text('Create private book')),
                        BookActionStatus(workflow: workflow),
                        if (workflow.pendingDetails case final details?)
                          Text(
                              '${details['title']}\n${details['authorName']} · ${details['language']}'),
                        if (workflow.book case final book?) ...[
                          Text(book.title,
                              style: Theme.of(context).textTheme.titleLarge),
                          const SizedBox(height: 12),
                          FilledButton.icon(
                              onPressed: workflow.busy
                                  ? null
                                  : () => Navigator.of(context).pushReplacement(
                                      MaterialPageRoute<void>(
                                          builder: (_) => BookOverviewScreen(
                                              auth: widget.auth, book: book))),
                              icon: const Icon(Icons.arrow_forward),
                              label: const Text('Open book')),
                        ]
                      ]))),
    );
  }
}
