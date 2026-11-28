import 'package:flutter/material.dart';
import 'auth.dart';
import 'screens/auth_screen.dart';
import 'screens/home_screen.dart';
import 'screens/books_screen.dart';
import 'screens/ai_assistant_screen.dart';
import 'screens/community_screen.dart';
import 'screens/settings_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final auth = await AuthState.init(
      supabaseUrl: const String.fromEnvironment('SUPABASE_URL'),
      supabaseAnonKey: const String.fromEnvironment('SUPABASE_PUBLISHABLE_KEY'),
      apiBaseUrl: const String.fromEnvironment('API_BASE_URL'),
      webBaseUrl: const String.fromEnvironment('WEB_APP_URL'),
    );
    runApp(BookwormApp(auth: auth));
  } on Exception {
    runApp(MaterialApp(
        theme: bookwormTheme(),
        home: const Scaffold(
            body: SafeArea(
                child: Center(
                    child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Text(
                            'Bookworm could not start securely. Check the app configuration and connection, then reopen the app.')))))));
  }
}

ThemeData bookwormTheme() => ThemeData(
      colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF9DBB9D), brightness: Brightness.dark),
      useMaterial3: true,
      inputDecorationTheme:
          const InputDecorationTheme(border: OutlineInputBorder()),
    );

class BookwormApp extends StatelessWidget {
  const BookwormApp({super.key, required this.auth});
  final AuthState auth;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: auth,
      builder: (_, __) => MaterialApp(
            // Changing account/workspace destroys every previous private route.
            key: ValueKey(auth.scopeKey), title: 'AI Bookworm',
            theme: bookwormTheme(),
            home: !auth.signedIn || auth.recoveringPassword
                ? AuthScreen(auth: auth)
                : auth.workspace == null
                    ? WorkspaceGate(auth: auth)
                    : AppShell(auth: auth),
          ));
}

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.auth});
  final AuthState auth;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _index = 0;
  @override
  Widget build(BuildContext context) {
    final pages = [
      HomeScreen(auth: widget.auth),
      BooksScreen(auth: widget.auth),
      AiAssistantScreen(auth: widget.auth),
      CommunityScreen(auth: widget.auth),
      SettingsScreen(auth: widget.auth),
    ];
    return Scaffold(
        body: pages[_index],
        bottomNavigationBar: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (index) => setState(() => _index = index),
          destinations: const [
            NavigationDestination(
                icon: Icon(Icons.home_outlined), label: 'Home'),
            NavigationDestination(
                icon: Icon(Icons.menu_book_outlined), label: 'Books'),
            NavigationDestination(icon: Icon(Icons.auto_awesome), label: 'AI'),
            NavigationDestination(
                icon: Icon(Icons.groups_outlined), label: 'Community'),
            NavigationDestination(
                icon: Icon(Icons.settings_outlined), label: 'Settings'),
          ],
        ));
  }
}

class WorkspaceGate extends StatefulWidget {
  const WorkspaceGate({super.key, required this.auth});
  final AuthState auth;
  @override
  State<WorkspaceGate> createState() => _WorkspaceGateState();
}

class _WorkspaceGateState extends State<WorkspaceGate> {
  final _name = TextEditingController();
  bool _busy = false;
  String? _message;
  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    if (_busy) return;
    if (_name.text.trim().isEmpty || _name.text.trim().length > 120) {
      setState(
          () => _message = 'Enter a workspace name, up to 120 characters.');
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    final error = await widget.auth.createWorkspace(_name.text);
    if (mounted)
      setState(() {
        _busy = false;
        _message = error;
      });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Your writing workspace')),
        body: SafeArea(
            child: Center(
                child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (widget.auth.loading)
                    const Center(child: CircularProgressIndicator())
                  else if (widget.auth.error != null) ...[
                    Text(widget.auth.error!, semanticsLabel: widget.auth.error),
                    const SizedBox(height: 16),
                    FilledButton(
                        onPressed: widget.auth.refreshWorkspaces,
                        child: const Text('Retry workspace access')),
                  ] else ...[
                    Text('Make room for your next book',
                        style: Theme.of(context).textTheme.headlineMedium),
                    const SizedBox(height: 12),
                    const Text(
                        'Create a private workspace for your manuscripts, book memory and publishing files. AI generation requires funded credits.'),
                    const SizedBox(height: 24),
                    TextField(
                        controller: _name,
                        enabled: !_busy,
                        maxLength: 120,
                        decoration:
                            const InputDecoration(labelText: 'Workspace name'),
                        onSubmitted: (_) => _create()),
                    if (_message != null)
                      Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Text(_message!)),
                    FilledButton(
                        onPressed: _busy ? null : _create,
                        child: Text(_busy ? 'Creating…' : 'Create workspace')),
                    TextButton(
                        onPressed: _busy ? null : widget.auth.refreshWorkspaces,
                        child: const Text('Check existing workspaces')),
                  ],
                  const SizedBox(height: 16),
                  TextButton(
                      onPressed: () async {
                        try {
                          await widget.auth.signOut();
                        } on Exception {
                          if (mounted)
                            setState(() => _message =
                                'Sign-out could not be confirmed. Try again.');
                        }
                      },
                      child: const Text('Sign out')),
                ],
              )),
        ))),
      );
}
