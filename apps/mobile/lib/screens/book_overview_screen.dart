import 'package:flutter/material.dart';

import '../auth.dart';
import '../book_workflow.dart';
import '../models.dart';
import 'ai_assistant_screen.dart';
import 'assets_screen.dart';
import 'book_action_status.dart';
import 'publishing_screen.dart';
import 'reader_screen.dart';

class BookOverviewScreen extends StatefulWidget {
  const BookOverviewScreen({super.key, required this.auth, required this.book});
  final AuthState auth;
  final Book book;
  @override
  State<BookOverviewScreen> createState() => _BookOverviewScreenState();
}

class _BookOverviewScreenState extends State<BookOverviewScreen> {
  NativeBookWorkflow? _workflow;
  @override
  void initState() {
    super.initState();
    final api = widget.auth.api, user = widget.auth.user;
    if (api != null &&
        user != null &&
        widget.auth.workspace?.id == widget.book.workspaceId) {
      _workflow = NativeBookWorkflow(
          api: api,
          userId: user.id,
          workspaceId: widget.book.workspaceId,
          bookId: widget.book.id);
      _workflow!.refresh();
    }
  }

  @override
  void dispose() {
    _workflow?.dispose();
    super.dispose();
  }

  Future<void> _open(Widget screen) async {
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => screen));
    if (mounted) await _workflow?.refresh();
  }

  Future<void> _chapter() async {
    var title = '';
    final accepted = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
              title: const Text('Add a chapter'),
              content: TextField(
                  autofocus: true,
                  maxLength: 500,
                  decoration: const InputDecoration(labelText: 'Chapter title'),
                  onChanged: (value) => title = value),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dialog, false),
                    child: const Text('Cancel')),
                FilledButton(
                    onPressed: () => Navigator.pop(dialog, true),
                    child: const Text('Add chapter'))
              ],
            ));
    if (accepted == true && mounted) await _workflow!.addChapter(title);
  }

  Future<void> _import() async {
    final asset = await Navigator.of(context).push<AssetItem>(MaterialPageRoute(
        builder: (_) =>
            AssetsScreen(auth: widget.auth, selectManuscript: true)));
    if (asset == null || !mounted) return;
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
              title: const Text('Import into this book?'),
              content: Text(
                  '${asset.name}\n${(asset.sizeBytes / (1024 * 1024)).toStringAsFixed(2)} MiB\n\n'
                  'Import the current screened file into “${widget.book.title}”. Existing chapters are preserved; imported chapters are added, not replaced. Review conversion warnings and formatting afterward. No AI generation is included.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dialog, false),
                    child: const Text('Cancel')),
                FilledButton(
                    onPressed: () => Navigator.pop(dialog, true),
                    child: const Text('Import manuscript'))
              ],
            ));
    if (confirmed == true && mounted) await _workflow!.importAsset(asset);
  }

  Future<void> _retry(ManuscriptImportJob job) async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
              title: const Text('Retry the original import?'),
              content: const Text(
                  'This retries the same source and job. It does not upload a replacement or start AI generation. Fix any source or processing issue first.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dialog, false),
                    child: const Text('Cancel')),
                FilledButton(
                    onPressed: () => Navigator.pop(dialog, true),
                    child: const Text('Retry original import'))
              ],
            ));
    if (confirmed == true && mounted) await _workflow!.retryImport(job);
  }

  @override
  Widget build(BuildContext context) {
    final workflow = _workflow;
    if (workflow == null)
      return Scaffold(
          appBar: AppBar(title: const Text('Book unavailable')),
          body: const Center(
              child: Text(
                  'Select the original workspace before opening this book.')));
    return ListenableBuilder(
        listenable: workflow,
        builder: (context, _) => Scaffold(
              appBar: AppBar(
                  title: Text(workflow.book?.title ?? widget.book.title),
                  actions: [
                    IconButton(
                        tooltip: 'Refresh book and imports',
                        onPressed: workflow.busy ? null : workflow.refresh,
                        icon: const Icon(Icons.refresh))
                  ]),
              body: SafeArea(
                  child: RefreshIndicator(
                      onRefresh: workflow.refresh,
                      child: ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.all(20),
                          children: [
                            Text(
                                workflow.book?.authorName ??
                                    widget.book.authorName,
                                style: Theme.of(context).textTheme.titleSmall),
                            BookActionStatus(workflow: workflow),
                            Wrap(spacing: 8, runSpacing: 8, children: [
                              FilledButton.icon(
                                  onPressed:
                                      workflow.canStart && workflow.canEdit
                                          ? _chapter
                                          : null,
                                  icon: const Icon(Icons.add),
                                  label: const Text('Add chapter')),
                              OutlinedButton.icon(
                                  onPressed:
                                      workflow.canStart && workflow.canEdit
                                          ? _import
                                          : null,
                                  icon: const Icon(Icons.upload_file),
                                  label: const Text('Import manuscript')),
                            ]),
                            const SizedBox(height: 16),
                            Wrap(spacing: 8, runSpacing: 8, children: [
                              ActionChip(
                                  avatar:
                                      const Icon(Icons.auto_awesome, size: 18),
                                  label: const Text('AI Assistant'),
                                  onPressed: () => _open(AiAssistantScreen(
                                      auth: widget.auth, book: widget.book))),
                              ActionChip(
                                  avatar: const Icon(Icons.folder_outlined,
                                      size: 18),
                                  label: const Text('Files & artwork'),
                                  onPressed: () =>
                                      _open(AssetsScreen(auth: widget.auth))),
                              ActionChip(
                                  avatar: const Icon(Icons.publish, size: 18),
                                  label: const Text('Publishing'),
                                  onPressed: () => _open(PublishingScreen(
                                      auth: widget.auth, book: widget.book))),
                            ]),
                            const Divider(height: 32),
                            Text('Chapters (${workflow.chapters.length})',
                                style: Theme.of(context).textTheme.titleLarge),
                            if (workflow.chapters.isEmpty && !workflow.busy)
                              const Padding(
                                  padding: EdgeInsets.symmetric(vertical: 16),
                                  child: Text(
                                      'Write a chapter or import a manuscript to begin.')),
                            for (final chapter in workflow.chapters)
                              ListTile(
                                  key: ValueKey(chapter.id),
                                  contentPadding: EdgeInsets.zero,
                                  title: Text(chapter.title),
                                  subtitle: Text(
                                      'Chapter ${chapter.orderIndex + 1} · ${chapter.status}'),
                                  trailing: const Icon(Icons.chevron_right),
                                  onTap: () => _open(ReaderScreen(
                                      auth: widget.auth,
                                      chapter: chapter,
                                      workspaceId: widget.book.workspaceId))),
                            if (workflow.jobs.isNotEmpty) ...[
                              const Divider(height: 32),
                              Text('Import history',
                                  style:
                                      Theme.of(context).textTheme.titleLarge),
                              const Text(
                                  'Showing the latest 50 imports. A saved receipt confirms conversion; review imported chapters before publishing.'),
                              for (final job in workflow.jobs)
                                Card(
                                    child: Padding(
                                        padding: const EdgeInsets.all(16),
                                        child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.stretch,
                                            children: [
                                              Text(
                                                  'Import ${job.id.substring(0, 8)} · ${job.status}',
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .titleMedium),
                                              Text('Attempts: ${job.attempts}'),
                                              if (job.status == 'failed')
                                                const Text(
                                                    'Original source preserved. Review its format and processing availability before retrying.'),
                                              TextButton(
                                                  onPressed: workflow.busy
                                                      ? null
                                                      : () => workflow
                                                          .inspectImport(job),
                                                  child: const Text(
                                                      'Check import receipt')),
                                              if (job.status == 'failed' &&
                                                  workflow.canEdit)
                                                OutlinedButton(
                                                    onPressed: workflow.busy
                                                        ? null
                                                        : () => _retry(job),
                                                    child: const Text(
                                                        'Retry original import')),
                                              if (workflow.reports[job.assetId]
                                                  case final report?) ...[
                                                Text(
                                                    'Saved conversion: ${report.chapterIds.length} chapters · ${report.imageCount} images'),
                                                if (report.warnings.isEmpty)
                                                  const Text(
                                                      'No conversion warnings. Still review formatting.'),
                                                for (final warning
                                                    in report.warnings)
                                                  Padding(
                                                      padding:
                                                          const EdgeInsets.only(
                                                              top: 8),
                                                      child: Text(warning)),
                                              ],
                                            ]))),
                            ],
                          ]))),
            ));
  }
}
