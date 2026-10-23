import 'package:flutter/material.dart';
import '../auth.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.auth});
  final AuthState auth;
  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController(),
      _password = TextEditingController(),
      _name = TextEditingController();
  bool _signupMode = false, _busy = false;
  String? _message;
  bool get _recovery => widget.auth.recoveringPassword;
  String? _emailError() =>
      RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(_email.text.trim())
          ? null
          : 'Enter a valid email address.';

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _run(Future<String?> Function() action,
      {String? success}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final error = await action();
      if (mounted) setState(() => _message = error ?? success);
    } on Exception {
      if (mounted)
        setState(() => _message =
            'Sign-in could not be completed. Check your connection and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    if (_busy || _form.currentState?.validate() != true) return;
    await _run(
        () => _recovery
            ? widget.auth.updatePassword(_password.text)
            : _signupMode
                ? widget.auth.signup(_email.text.trim(), _password.text,
                    name: _name.text)
                : widget.auth.login(_email.text.trim(), _password.text),
        success: _signupMode
            ? 'If confirmation is required, check your email to continue.'
            : null);
  }

  Future<void> _reset() async {
    final error = _emailError();
    if (error != null) {
      setState(() => _message = error);
      return;
    }
    await _run(() => widget.auth.resetPassword(_email.text.trim()),
        success:
            'If this address has an account, a password reset link is on its way.');
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
            child: Center(
                child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: AutofillGroup(
                child: Form(
                    key: _form,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Icon(Icons.auto_stories_outlined, size: 48),
                        const SizedBox(height: 16),
                        Text(
                            _recovery
                                ? 'Choose a new password'
                                : _signupMode
                                    ? 'Create your Bookworm account'
                                    : 'Welcome to Bookworm',
                            style: Theme.of(context).textTheme.headlineMedium,
                            textAlign: TextAlign.center),
                        const SizedBox(height: 12),
                        const Text(
                            'Your books, creative memory and publishing workspace.',
                            textAlign: TextAlign.center),
                        const SizedBox(height: 28),
                        if (!_recovery) ...[
                          OutlinedButton.icon(
                              onPressed: _busy
                                  ? null
                                  : () => _run(widget.auth.googleSignIn),
                              icon: const Icon(Icons.login),
                              label: const Text('Continue with Google')),
                          const SizedBox(height: 24),
                          if (_signupMode) ...[
                            TextFormField(
                                controller: _name,
                                enabled: !_busy,
                                autofillHints: const [AutofillHints.name],
                                decoration:
                                    const InputDecoration(labelText: 'Name'),
                                maxLength: 120,
                                validator: (value) =>
                                    value?.trim().isNotEmpty == true
                                        ? null
                                        : 'Enter your name.'),
                            const SizedBox(height: 12),
                          ],
                          TextFormField(
                              controller: _email,
                              enabled: !_busy,
                              keyboardType: TextInputType.emailAddress,
                              autocorrect: false,
                              autofillHints: const [AutofillHints.username],
                              decoration:
                                  const InputDecoration(labelText: 'Email'),
                              validator: (_) => _emailError()),
                          const SizedBox(height: 16),
                        ],
                        TextFormField(
                            controller: _password,
                            enabled: !_busy,
                            obscureText: true,
                            autocorrect: false,
                            autofillHints: [
                              _signupMode || _recovery
                                  ? AutofillHints.newPassword
                                  : AutofillHints.password
                            ],
                            decoration: InputDecoration(
                                labelText:
                                    _recovery ? 'New password' : 'Password'),
                            validator: (value) => value == null || value.isEmpty
                                ? 'Enter your password.'
                                : (_signupMode || _recovery) && value.length < 8
                                    ? 'Use at least 8 characters.'
                                    : null,
                            onFieldSubmitted: (_) => _submit()),
                        if (_message != null)
                          Semantics(
                              liveRegion: true,
                              child: Padding(
                                  padding:
                                      const EdgeInsets.symmetric(vertical: 16),
                                  child: Text(_message!))),
                        const SizedBox(height: 20),
                        FilledButton(
                            onPressed: _busy ? null : _submit,
                            child: Text(_busy
                                ? 'Please wait…'
                                : _recovery
                                    ? 'Save new password'
                                    : _signupMode
                                        ? 'Create account'
                                        : 'Sign in')),
                        if (!_recovery) ...[
                          TextButton(
                              onPressed: _busy
                                  ? null
                                  : () => setState(() {
                                        _signupMode = !_signupMode;
                                        _message = null;
                                      }),
                              child: Text(_signupMode
                                  ? 'Already registered? Sign in'
                                  : 'Create an account')),
                          TextButton(
                              onPressed: _busy ? null : _reset,
                              child: const Text('Forgot password')),
                        ],
                      ],
                    ))),
          ),
        ))),
      );
}
