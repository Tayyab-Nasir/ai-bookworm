import 'package:flutter/material.dart';
import '../book_workflow.dart';

class BookActionStatus extends StatelessWidget {
  const BookActionStatus({super.key, required this.workflow});
  final NativeBookWorkflow workflow;

  Future<void> _discard(BuildContext context) async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
              title: const Text('Discard local retry details?'),
              content: const Text(
                  'Check your saved library and import history first. This does not cancel or delete any server request, book, chapter or file. Starting again may create a duplicate.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dialog, false),
                    child: const Text('Keep details')),
                TextButton(
                    onPressed: () => Navigator.pop(dialog, true),
                    child: const Text('Discard local details'))
              ],
            ));
    if (confirmed == true && context.mounted) await workflow.discard();
  }

  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (workflow.busy) const LinearProgressIndicator(),
        Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Semantics(liveRegion: true, child: Text(workflow.message))),
        if (workflow.pendingKind != null) ...[
          Text('Saved action: ${workflow.pendingLabel}',
              style: Theme.of(context).textTheme.titleSmall),
          OutlinedButton(
              onPressed: workflow.busy ? null : workflow.resume,
              child: const Text('Resume saved action')),
        ],
        if (workflow.pendingKind != null || !workflow.loaded) ...[
          OutlinedButton(
              onPressed: workflow.busy ? null : workflow.refresh,
              child: const Text('Check saved status')),
          TextButton(
              onPressed: workflow.busy ? null : () => _discard(context),
              child: const Text('Discard local retry details')),
        ],
      ]);
}
