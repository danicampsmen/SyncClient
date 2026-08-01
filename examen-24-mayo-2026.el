;; -*- lexical-binding: t; -*-

(TeX-add-style-hook
 "examen-24-mayo-2026"
 (lambda ()
   (TeX-add-to-alist 'LaTeX-provided-class-options
                     '(("examen-article-academia20" "")))
   (TeX-run-style-hooks
    "latex2e"
    "examen-article-academia20"
    "examen-article-academia2010"))
 :latex)

