import 'package:flutter/material.dart';

void main() => runApp(const BookwormApp());

class BookwormApp extends StatelessWidget {
  const BookwormApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AI Bookworm',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const Scaffold(
        body: Center(child: Text('AI Bookworm — mobile companion (Step 13)')),
      ),
    );
  }
}
