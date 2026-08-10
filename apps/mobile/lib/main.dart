import 'package:flutter/material.dart';

import 'auth.dart';
import 'screens/ai_assistant_screen.dart';
import 'screens/auth_screen.dart';
import 'screens/books_screen.dart';
import 'screens/community_screen.dart';
import 'screens/home_screen.dart';
import 'screens/settings_screen.dart';

// Configure at build time:
//   flutter run --dart-define=SUPABASE_URL=... --dart-define=SUPABASE_ANON_KEY=...
//     --dart-define=API_BASE_URL=http://localhost:3001
//     --dart-define=AI_BASE_URL=http://localhost:8000
const _supabaseUrl = String.fromEnvironment('SUPABASE_URL');
const _supabaseAnonKey = String.fromEnvironment('SUPABASE_ANON_KEY');
const _apiBaseUrl =
    String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:3001');
const _aiBaseUrl =
    String.fromEnvironment('AI_BASE_URL', defaultValue: 'http://localhost:8000');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (_supabaseUrl.isEmpty || _supabaseAnonKey.isEmpty) {
    runApp(const _MissingConfigApp());
    return;
  }
  final auth = await AuthState.init(
    supabaseUrl: _supabaseUrl,
    supabaseAnonKey: _supabaseAnonKey,
    apiBaseUrl: _apiBaseUrl,
    aiBaseUrl: _aiBaseUrl,
  );
  runApp(BookwormApp(auth: auth));
}

class _MissingConfigApp extends StatelessWidget {
  const _MissingConfigApp();

  @override
  Widget build(BuildContext context) => const MaterialApp(
        home: Scaffold(
          body: Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                'Missing config. Run with --dart-define=SUPABASE_URL=... '
                '--dart-define=SUPABASE_ANON_KEY=...',
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ),
      );
}

class BookwormApp extends StatelessWidget {
  const BookwormApp({super.key, required this.auth});
  final AuthState auth;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AI Bookworm',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: AnimatedBuilder(
        animation: auth,
        builder: (_, __) =>
            auth.signedIn ? AppShell(auth: auth) : AuthScreen(auth: auth),
      ),
    );
  }
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
    final auth = widget.auth;
    final pages = [
      HomeScreen(auth: auth),
      BooksScreen(auth: auth),
      AiAssistantScreen(auth: auth),
      CommunityScreen(auth: auth),
      SettingsScreen(auth: auth),
    ];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), label: 'Home'),
          NavigationDestination(
              icon: Icon(Icons.menu_book_outlined), label: 'Books'),
          NavigationDestination(
              icon: Icon(Icons.auto_awesome), label: 'AI'),
          NavigationDestination(
              icon: Icon(Icons.groups_outlined), label: 'Community'),
          NavigationDestination(
              icon: Icon(Icons.settings_outlined), label: 'Settings'),
        ],
      ),
    );
  }
}
