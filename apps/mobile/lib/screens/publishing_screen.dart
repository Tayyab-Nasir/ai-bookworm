import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../auth.dart';
import '../models.dart';

/// Publishing: run deterministic preflight and watch job status. Preflight
/// rules live server-side; this only renders the report. Job list reads the
/// publishing_jobs table via Supabase (RLS-gated) since the API has no list
/// endpoint yet.
class PublishingScreen extends StatefulWidget {
  const PublishingScreen({super.key, required this.auth, required this.book});
  final AuthState auth;
  final Book book;

  @override
  State<PublishingScreen> createState() => _PublishingScreenState();
}

class _PublishingScreenState extends State<PublishingScreen> {
  Map<String, dynamic>? _report;
  List<PublishingJob> _jobs = const [];
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadJobs();
  }

  Future<void> _loadJobs() async {
    try {
      final rows = await Supabase.instance.client
          .from('publishing_jobs')
          .select()
          .eq('book_id', widget.book.id)
          .order('created_at', ascending: false);
      if (!mounted) return;
      setState(() {
        _jobs = [
          for (final r in rows)
            PublishingJob.fromJson((r as Map).cast<String, dynamic>()),
        ];
        _error = null;
      });
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _validate() async {
    final api = widget.auth.api;
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final report = await api.runPreflight(widget.book.id);
      if (mounted) setState(() => _report = report);
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _createJob() async {
    final api = widget.auth.api;
    if (api == null) return;
    try {
      await api.createPublishingJob(
        widget.book.id,
        channel: 'export',
        idempotencyKey:
            'mobile-pub-${widget.book.id}-${DateTime.now().microsecondsSinceEpoch}',
      );
      await _loadJobs();
    } on Exception catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString())));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final findings = (_report?['findings'] as List?) ?? const [];
    return Scaffold(
      appBar: AppBar(title: Text('Publishing — ${widget.book.title}')),
      body: RefreshIndicator(
        onRefresh: _loadJobs,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (_error != null) Text(_error!),
            Row(
              children: [
                FilledButton.tonal(
                  onPressed: _busy ? null : _validate,
                  child: Text(_busy ? 'Validating…' : 'Run preflight'),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: _createJob,
                  child: const Text('Export job'),
                ),
              ],
            ),
            if (_report != null) ...[
              const Divider(height: 32),
              Text('Preflight report',
                  style: Theme.of(context).textTheme.titleMedium),
              if (findings.isEmpty) const Text('No findings.'),
              for (final f in findings)
                ListTile(
                  dense: true,
                  leading: Icon(
                    (f as Map)['severity'] == 'error'
                        ? Icons.error_outline
                        : Icons.warning_amber,
                  ),
                  title: Text(f['message'] as String? ?? f.toString()),
                  subtitle: f['location'] != null
                      ? Text(f['location'].toString())
                      : null,
                ),
            ],
            const Divider(height: 32),
            Text('Jobs', style: Theme.of(context).textTheme.titleMedium),
            for (final j in _jobs)
              ListTile(
                title: Text(j.channel),
                subtitle: Text(j.createdAt.toLocal().toString()),
                trailing: Chip(label: Text(j.status)),
              ),
            if (_jobs.isEmpty) const ListTile(title: Text('No jobs yet')),
          ],
        ),
      ),
    );
  }
}
