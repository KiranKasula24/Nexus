import pypdf
import os

pdf_path = r'C:\Projects\nexus\nexus_MU.pdf'
with open(pdf_path, 'rb') as f:
    reader = pypdf.PdfReader(f)
    for i, page in enumerate(reader.pages):
        print(f'--- Page {i+1} ---')
        print(page.extract_text())
