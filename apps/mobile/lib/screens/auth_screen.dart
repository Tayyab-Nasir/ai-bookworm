import 'package:flutter/material.dart';

import '../auth.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.auth});
  final AuthState auth;

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _signupMode = false;
  bool _busy = false;
  String? _message;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    final err = _signupMode
        ? await widget.auth.signup(_email.text.trim(), _password.text)
        : await widget.auth.login(_email.text.trim(), _password.text);
    if (mounted) {
      setState(() {
        _busy = false;
        _message = err ?? (_signupMode ? 'Check your email to confirm.' : null);
      });
    }
  }

  Future<void> _reset() async {
    final err = await widget.auth.resetPassword(_email.text.trim());
    if (mounted) {
      setState(() => _message = err ?? 'Reset email sent.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('AI Bookworm',
                    style: Theme.of(context).textTheme.headlineMedium),
                const SizedBox(height: 24),
                TextField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'Email'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _password,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Password'),
                  onSubmitted: (_) => _submit(),
                ),
                const SizedBox(height: 16),
                if (_message != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(_message!),
                  ),
                FilledButton(
                  onPressed: _busy ? null : _submit,
                  child: Text(_signupMode ? 'Sign up' : 'Log in'),
                ),
                TextButton(
                  onPressed: () =>
                      setState(() => _signupMode = !_signupMode),
                  child: Text(_signupMode
                      ? 'Have an account? Log in'
                      : 'Need an account? Sign up'),
                ),
                TextButton(
                  onPressed: _reset,
                  child: const Text('Forgot password'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
