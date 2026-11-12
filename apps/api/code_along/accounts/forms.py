from django import forms
from django.contrib.auth.base_user import AbstractBaseUser
from django.http import HttpRequest


class SignupProfileForm(forms.Form):
    display_name = forms.CharField(max_length=80, strip=True)

    def signup(self, request: HttpRequest, user: AbstractBaseUser) -> None:
        # Adapter saves this field before the initial account INSERT.
        pass
