import 'package:flutter/material.dart';

import '../auth.dart';
import '../models.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.auth});
  final AuthState auth;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  UsageInfo? _usage;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.auth.addListener(_loadUsage);
    _loadUsage();
  }

  @override
  void dispose() {
    widget.auth.removeListener(_loadUsage);
    super.dispose();
  }

  Future<void> _loadUsage() async {
    final api = widget.auth.api;
    final orgId = widget.auth.workspace?.organizationId;
    if (api == null || orgId == null || orgId.isEmpty) return;
    try {
      final usage = await api.getUsage(orgId);
      if (mounted) setState(() => _usage = usage);
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.auth.user;
    final usage = _usage;
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          ListTile(
            leading: const Icon(Icons.person_outline),
            title: Text(user?.email ?? 'Not signed in'),
            subtitle: Text(user?.id ?? ''),
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.workspaces_outlined),
            title: const Text('Workspace'),
            trailing: DropdownButton<Workspace>(
              value: widget.auth.workspace,
              underline: const SizedBox.shrink(),
              items: [
                for (final w in widget.auth.workspaces)
                  DropdownMenuItem(value: w, child: Text(w.name)),
              ],
              onChanged: (w) {
                if (w != null) widget.auth.selectWorkspace(w);
              },
            ),
          ),
          const Divider(),
          if (_error != null) Text(_error!),
          if (usage != null) ...[
            ListTile(
              leading: const Icon(Icons.bolt_outlined),
              title: const Text('Credit balance'),
              trailing: Text('${usage.creditBalance}'),
            ),
            for (final e in usage.usage.entries)
              ListTile(
                dense: true,
                title: Text(e.key),
                trailing: Text(e.value.toStringAsFixed(0)),
              ),
          ],
          const Divider(),
          ListTile(
            leading: const Icon(Icons.logout),
            title: const Text('Sign out'),
            onTap: widget.auth.signOut,
          ),
        ],
      ),
    );
  }
}
